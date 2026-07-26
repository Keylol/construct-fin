import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from './crypto.service';
import { AdapterRegistry } from './adapter-registry';
import type { RawBankLine } from './provider-adapter';
import { applyRules, type RuleCondition, type RuleAction } from '../rule/engine';
import { sanitizeSecrets, sanitizeSecretsDeep } from '../common/sanitize-secrets';

/**
 * Сколько дней хранить сырой ответ провайдера (BankStatementLine.raw).
 * Дальше — обнуление кроном purgeStaleRaw(): форензика нужна по свежим синкам,
 * а реквизиты контрагентов бессрочно в каждом бэкапе — нет.
 */
const RAW_TTL_DAYS = 30;

export interface SyncResult {
  fetched: number;
  created: number;
  autoPosted: number;
}

/**
 * Синхронизация выписки подключения (Ф1-B). Общий пайплайн для всех
 * провайдеров:
 *   adapter.fetchStatement(cursor)
 *     → идемпотентный upsert строк по (connectionId, externalId)
 *     → Rule-движок: строка с подсказкой категории → авто-проводка (AUTO_POSTED)
 *     → остальное → NEW в Inbox (разбор оператором, Ф1-C/E)
 *
 * Идемпотентность: строка с уже виденным externalId пропускается (constraint
 * @@unique — последняя линия защиты). Авто-проводка обратима: правка/удаление
 * созданной проводки возвращает строку в Inbox (реализуется в Ф1-C).
 *
 * Детект переводов между своими счетами (плановый) пока НЕ авто-создаёт Transfer:
 * во избежание ложных срабатываний, скрывающих доход/расход, перевод
 * подтверждается вручную действием Inbox (Ф1-C). См. docs/master-plan-full-auto.
 */
@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly registry: AdapterRegistry,
  ) {}

  /** Ежечасный фоновый синк всех активных подключений (решение №12). */
  @Cron(CronExpression.EVERY_HOUR)
  async syncAllActive(): Promise<void> {
    const connections = await this.prisma.integrationConnection.findMany({
      where: { status: 'ACTIVE', deletedAt: null },
      select: { id: true },
    });
    for (const c of connections) {
      // Падение одного подключения не должно останавливать остальные.
      try {
        await this.syncConnection(c.id);
      } catch (e) {
        this.logger.error(
          `Плановый синк подключения ${c.id} упал: ${sanitizeSecrets(
            e instanceof Error ? e.message : String(e),
          )}`,
        );
      }
    }
  }

  /**
   * TTL сырых ответов провайдера: раз в сутки обнуляем `raw` у строк выписки
   * старше RAW_TTL_DAYS.
   *
   * `raw` нужен для разбора «почему адаптер так прочитал операцию» — это вопрос
   * первых дней после синка. Дальше колонка превращается в бессрочный склад
   * реквизитов контрагентов (счета, БИК, назначения) в каждом бэкапе. Сами
   * строки выписки не трогаем — только сырой ответ.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async purgeStaleRaw(): Promise<{ purged: number }> {
    const cutoff = new Date(Date.now() - RAW_TTL_DAYS * 24 * 60 * 60 * 1000);
    const res = await this.prisma.bankStatementLine.updateMany({
      where: { createdAt: { lt: cutoff }, raw: { not: Prisma.DbNull } },
      data: { raw: Prisma.DbNull },
    });
    if (res.count > 0) {
      this.logger.log(`TTL raw: обнулено сырых ответов — ${res.count} (старше ${RAW_TTL_DAYS} дн.)`);
    }
    return { purged: res.count };
  }

  /** Синхронизировать одно подключение. Возвращает счётчики для UI-кнопки. */
  async syncConnection(connectionId: string): Promise<SyncResult> {
    const conn = await this.prisma.integrationConnection.findFirst({
      where: { id: connectionId, deletedAt: null },
    });
    if (!conn) throw new NotFoundException('Подключение не найдено');
    if (conn.status === 'DISABLED') return { fetched: 0, created: 0, autoPosted: 0 };

    try {
      // Уровень подключения: decrypt + запрос выписки. Отказ здесь = ERROR.
      const token = this.crypto.decrypt(conn.credentialEnc);
      const adapter = this.registry.resolve(conn.provider);
      const { lines, nextCursor } = await adapter.fetchStatement({
        token,
        cursor: conn.syncCursor,
        // Номер счёта у провайдера (Альфа) и дата подключения: история тянется
        // с момента подключения, прошлое уже занесено руками (решение №15).
        accountNumber: conn.externalAccountId,
        connectedAt: conn.createdAt,
      });
      const rules = await this.loadRules(conn.workspaceId);

      let created = 0;
      let autoPosted = 0;
      for (const line of lines) {
        try {
          const posted = await this.ingestLine(conn, line, rules);
          if (posted !== null) {
            created++;
            if (posted) autoPosted++;
          }
        } catch (e) {
          // Гонка/повтор синка: строка уже вставлена другим проходом — строка
          // уже в БД, идемпотентно пропускаем (не роняем весь синк в ERROR).
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
            continue;
          }
          throw e; // реальная ошибка БД — наверх в ERROR
        }
      }

      await this.prisma.integrationConnection.update({
        where: { id: conn.id },
        data: {
          syncCursor: nextCursor,
          lastSyncAt: new Date(),
          status: 'ACTIVE',
          lastSyncError: null,
        },
      });
      return { fetched: lines.length, created, autoPosted };
    } catch (e) {
      // Текст ошибки провайдера хранится в БД и показывается в UI интеграций —
      // прогоняем через sanitize: сообщения HTTP-клиентов несут URL с
      // ?access_token=…, заголовок Authorization и тело ответа банка.
      const message = sanitizeSecrets(e instanceof Error ? e.message : String(e));
      await this.prisma.integrationConnection.update({
        where: { id: conn.id },
        data: { status: 'ERROR', lastSyncError: message.slice(0, 500) },
      });
      throw e;
    }
  }

  /**
   * Обработать одну строку выписки. Возвращает: null — уже загружена (пропуск);
   * true — авто-проводка создана; false — строка ушла в Inbox (NEW).
   * Правило-подсказка — best-effort: падение движка на строке не роняет синк,
   * строка просто уходит в Inbox без категории.
   */
  private async ingestLine(
    conn: { id: string; workspaceId: string; accountId: string; createdById: string },
    line: RawBankLine,
    rules: Awaited<ReturnType<SyncService['loadRules']>>,
  ): Promise<boolean | null> {
    const exists = await this.prisma.bankStatementLine.findUnique({
      where: {
        connectionId_externalId: { connectionId: conn.id, externalId: line.externalId },
      },
      select: { id: true },
    });
    if (exists) return null;

    let suggestedCategoryId: string | null = null;
    let suggestedCounterpartyId: string | null = null;
    try {
      const suggestion = applyRules(rules, {
        description: line.description,
        counterpartyName: line.counterpartyName,
        type: line.direction,
        amount: line.amount,
        source: 'IMPORT',
      });
      suggestedCategoryId = suggestion.categoryId ?? null;
      suggestedCounterpartyId = suggestion.counterpartyId ?? null;
    } catch (e) {
      this.logger.warn(
        `Правило упало на строке ${line.externalId} — уходит в Inbox без категории: ${
          e instanceof Error ? e.message : e
        }`,
      );
    }

    // Строка + (при подсказке категории) авто-проводка — атомарно.
    return this.prisma.$transaction(async (tx) => {
      if (suggestedCategoryId) {
        const transaction = await tx.transaction.create({
          data: {
            workspaceId: conn.workspaceId,
            accountId: conn.accountId,
            date: line.date,
            amount: new Prisma.Decimal(line.amount),
            type: line.direction,
            kind: 'OTHER',
            categoryId: suggestedCategoryId,
            counterpartyId: suggestedCounterpartyId,
            description: line.description,
            createdById: conn.createdById,
          },
          select: { id: true },
        });
        await tx.bankStatementLine.create({
          data: this.lineData(conn, line, {
            status: 'AUTO_POSTED',
            suggestedCategoryId,
            transactionId: transaction.id,
          }),
        });
        return true;
      }
      await tx.bankStatementLine.create({
        data: this.lineData(conn, line, { status: 'NEW', suggestedCategoryId }),
      });
      return false;
    });
  }

  /** Данные строки выписки для create — общая часть для авто/ручной ветки. */
  private lineData(
    conn: { id: string; workspaceId: string },
    line: RawBankLine,
    over: {
      status: 'NEW' | 'AUTO_POSTED';
      suggestedCategoryId: string | null;
      transactionId?: string;
    },
  ): Prisma.BankStatementLineUncheckedCreateInput {
    return {
      workspaceId: conn.workspaceId,
      connectionId: conn.id,
      externalId: line.externalId,
      date: line.date,
      amount: new Prisma.Decimal(line.amount),
      direction: line.direction,
      counterpartyName: line.counterpartyName ?? null,
      counterpartyInn: line.counterpartyInn ?? null,
      description: line.description ?? null,
      ausnMark: line.ausnMark ?? null,
      status: over.status,
      suggestedCategoryId: over.suggestedCategoryId,
      transactionId: over.transactionId ?? null,
      // Сырой ответ провайдера — только через sanitize: адаптер может отдать в
      // raw весь HTTP-response, включая эхо заголовка Authorization и полей
      // client_secret/access_token. Колонка попадает в каждый дамп БД, поэтому
      // секреты в неё не должны доехать даже случайно. Обнуляется по TTL —
      // см. purgeStaleRaw().
      raw: (line.raw == null
        ? null
        : sanitizeSecretsDeep(line.raw)) as Prisma.InputJsonValue,
    };
  }

  private async loadRules(workspaceId: string) {
    const rows = await this.prisma.rule.findMany({
      where: {
        workspaceId,
        isActive: true,
        deletedAt: null,
        appliesTo: { in: ['IMPORT', 'BOTH'] },
      },
      select: { id: true, name: true, priority: true, conditions: true, actions: true },
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      priority: r.priority,
      conditions: r.conditions as unknown as RuleCondition[],
      actions: r.actions as unknown as RuleAction[],
    }));
  }
}
