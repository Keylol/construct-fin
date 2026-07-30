import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AusnMark, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from './crypto.service';
import { AdapterRegistry } from './adapter-registry';
import type { RawBankLine } from './provider-adapter';
import { applyRules, type RuleCondition, type RuleAction } from '../rule/engine';
import { sanitizeSecrets, sanitizeSecretsDeep } from '../common/sanitize-secrets';
import { deserializeTlsCredential } from './tls-credential';

/**
 * Сколько дней хранить сырой ответ провайдера (BankStatementLine.raw).
 * Дальше — обнуление кроном purgeStaleRaw(): форензика нужна по свежим синкам,
 * а реквизиты контрагентов бессрочно в каждом бэкапе — нет.
 */
const RAW_TTL_DAYS = 30;

/**
 * Окно поиска ручного «двойника» строки выписки, в днях. Ручные записи датируют
 * приблизительно, банк — точно. Проверено на срезе прода: при ±5 дней на 198
 * операциях счёта неоднозначных пар (та же сумма и направление) — 2, столько же,
 * сколько при совпадении день-в-день; ±7 даёт уже 3. Отсюда 5.
 */
const ADOPT_WINDOW_DAYS = 5;

export interface SyncResult {
  fetched: number;
  created: number;
  autoPosted: number;
  /** Строк, привязанных к ранее внесённым вручную операциям (перезалив). */
  adopted: number;
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
    if (conn.status === 'DISABLED') {
      return { fetched: 0, created: 0, autoPosted: 0, adopted: 0 };
    }

    try {
      // Уровень подключения: decrypt + запрос выписки. Отказ здесь = ERROR.
      const token = this.crypto.decrypt(conn.credentialEnc);
      const adapter = this.registry.resolve(conn.provider);
      const { lines, nextCursor } = await adapter.fetchStatement({
        token,
        cursor: conn.syncCursor,
        // Номер счёта у провайдера (Альфа) и дата подключения: по умолчанию
        // история тянется с момента подключения (решение №15), но backfillFrom
        // перекрывает это — им забирают прошлое при перезаливе.
        accountNumber: conn.externalAccountId,
        connectedAt: conn.createdAt,
        backfillFrom: conn.backfillFrom,
        // Сертификат mTLS этого подключения (у разных ИП — разные сертификаты
        // от банка). Null → транспорт возьмёт запасной из env.
        tls: conn.tlsCredentialEnc
          ? deserializeTlsCredential(this.crypto.decrypt(conn.tlsCredentialEnc))
          : null,
      });
      const rules = await this.loadRules(conn.workspaceId);

      let created = 0;
      let autoPosted = 0;
      let adopted = 0;
      // Операции, уже усыновлённые в этом проходе: одна ручная операция не должна
      // достаться двум строкам выписки (кандидаты ищутся по сумме, а одинаковых
      // сумм в окне может быть несколько).
      const claimed = new Set<string>();
      for (const line of lines) {
        try {
          const posted = await this.ingestLine(conn, line, rules, claimed);
          if (posted !== null) {
            created++;
            if (posted === 'AUTO_POSTED') autoPosted++;
            if (posted === 'ADOPTED') adopted++;
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
      return { fetched: lines.length, created, autoPosted, adopted };
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
   * 'ADOPTED' — строка привязана к ранее внесённой вручную операции;
   * 'AUTO_POSTED' — правило создало проводку; 'NEW' — строка ушла в Inbox.
   * Правило-подсказка — best-effort: падение движка на строке не роняет синк,
   * строка просто уходит в Inbox без категории.
   */
  private async ingestLine(
    conn: { id: string; workspaceId: string; accountId: string; createdById: string },
    line: RawBankLine,
    rules: Awaited<ReturnType<SyncService['loadRules']>>,
    claimed: Set<string>,
  ): Promise<'ADOPTED' | 'AUTO_POSTED' | 'NEW' | null> {
    const exists = await this.prisma.bankStatementLine.findUnique({
      where: {
        connectionId_externalId: { connectionId: conn.id, externalId: line.externalId },
      },
      select: { id: true },
    });
    if (exists) return null;

    // Прежде чем плодить проводку — проверить, не внесена ли эта операция руками.
    // Иначе перезалив истории задвоил бы всё, что оператор уже завёл до
    // подключения банка.
    const twin = await this.findManualTwin(conn, line, claimed);
    if (twin) {
      claimed.add(twin.id);
      await this.adoptLine(conn, line, twin);
      return 'ADOPTED';
    }

    let suggestedCategoryId: string | null = null;
    let suggestedCounterpartyId: string | null = null;
    let appliedRuleId: string | null = null;
    try {
      const suggestion = applyRules(rules, {
        description: line.description,
        counterpartyName: line.counterpartyName,
        counterpartyInn: line.counterpartyInn,
        // Счёт известен из подключения (ниже он же идёт в проводку). Без него условие
        // ACCOUNT_EQUALS в банк-синке не срабатывало никогда.
        accountId: conn.accountId,
        type: line.direction,
        amount: line.amount,
        source: 'IMPORT',
      });
      suggestedCategoryId = suggestion.categoryId ?? null;
      suggestedCounterpartyId = suggestion.counterpartyId ?? null;
      appliedRuleId = suggestion.categoryRuleId ?? null;
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
            // Маркировку АУСН переносим так же, как ручной разбор (inbox.service.ts):
            // без неё авто-проведённые строки выпадали из расчёта налога.
            ausnMark: line.ausnMark,
            createdById: conn.createdById,
          },
          select: { id: true },
        });
        await tx.bankStatementLine.create({
          data: this.lineData(conn, line, {
            status: 'AUTO_POSTED',
            suggestedCategoryId,
            appliedRuleId,
            transactionId: transaction.id,
          }),
        });
        return 'AUTO_POSTED';
      }
      await tx.bankStatementLine.create({
        data: this.lineData(conn, line, { status: 'NEW', suggestedCategoryId }),
      });
      return 'NEW';
    });
  }

  /**
   * Найти операцию, которую оператор внёс руками до подключения банка, — ту же
   * самую, что сейчас приехала строкой выписки.
   *
   * Признаки: тот же счёт, то же направление, ровно та же сумма и дата в окне
   * ADOPT_WINDOW_DAYS (ручные записи датируют «примерно», банк — точно). Уже
   * привязанные к другой строке операции пропускаем: одна проводка — одна строка.
   *
   * Приоритет при нескольких кандидатах: сначала совпадение ИНН, потом ближайшая
   * по дате (порядок из Actual Budget: сначала высокая достоверность, потом
   * низкая — иначе слабый матч заберёт операцию, нужную сильному).
   */
  private async findManualTwin(
    conn: { workspaceId: string; accountId: string },
    line: RawBankLine,
    claimed: Set<string>,
  ): Promise<{ id: string; counterpartyId: string | null; ausnMark: AusnMark | null } | null> {
    const windowMs = ADOPT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const candidates = await this.prisma.transaction.findMany({
      where: {
        workspaceId: conn.workspaceId,
        accountId: conn.accountId,
        type: line.direction,
        amount: new Prisma.Decimal(line.amount),
        deletedAt: null,
        // Неденежные виды приезжать из банка не могут: себестоимость и списание
        // склада — это учётные проводки, а не движение по счёту.
        kind: { notIn: ['COGS', 'WRITE_OFF'] },
        // Строка выписки уже привязана к этой операции — второй раз нельзя.
        bankLine: { is: null },
        date: {
          gte: new Date(line.date.getTime() - windowMs),
          lte: new Date(line.date.getTime() + windowMs),
        },
      },
      select: {
        id: true,
        date: true,
        counterpartyId: true,
        ausnMark: true,
        counterparty: { select: { inn: true } },
      },
    });
    const free = candidates.filter((c) => !claimed.has(c.id));
    if (free.length === 0) return null;

    const inn = (line.counterpartyInn ?? '').replace(/\D/g, '');
    const byInn = inn
      ? free.filter((c) => (c.counterparty?.inn ?? '').replace(/\D/g, '') === inn)
      : [];
    const pool = byInn.length > 0 ? byInn : free;
    const best = pool.reduce((a, b) =>
      Math.abs(a.date.getTime() - line.date.getTime()) <=
      Math.abs(b.date.getTime() - line.date.getTime())
        ? a
        : b,
    );
    return { id: best.id, counterpartyId: best.counterpartyId, ausnMark: best.ausnMark };
  }

  /**
   * Привязать строку выписки к уже существующей операции. Новую проводку НЕ
   * создаём и правила не гоняем: разметка человека главнее подсказки движка.
   *
   * Пустые поля операции дозаполняем данными банка (контрагент по ИНН,
   * маркировка АУСН) — заполненные не трогаем. Ручные записи обычно без
   * контрагента вовсе, и выписка их обогащает; но то, что человек указал сам,
   * автоматика перезаписывать не вправе.
   */
  private async adoptLine(
    conn: { id: string; workspaceId: string; accountId: string; createdById: string },
    line: RawBankLine,
    twin: { id: string; counterpartyId: string | null; ausnMark: AusnMark | null },
  ): Promise<void> {
    const counterpartyId = twin.counterpartyId
      ? null
      : await this.resolveCounterparty(conn.workspaceId, line);
    const fill: Prisma.TransactionUpdateInput = {};
    if (counterpartyId) fill.counterparty = { connect: { id: counterpartyId } };
    if (!twin.ausnMark && line.ausnMark) fill.ausnMark = line.ausnMark;

    await this.prisma.$transaction(async (tx) => {
      if (Object.keys(fill).length > 0) {
        await tx.transaction.update({ where: { id: twin.id }, data: fill });
      }
      await tx.bankStatementLine.create({
        data: this.lineData(conn, line, {
          status: 'RESOLVED',
          suggestedCategoryId: null,
          transactionId: twin.id,
          adopted: true,
        }),
      });
    });
  }

  /**
   * Контрагент строки выписки: ищем по ИНН, затем по имени, иначе заводим.
   * ИНН — единственный надёжный ключ: банк форматирует наименования как придётся.
   * Без имени и ИНН (комиссии банка, переводы физлицам) контрагента не создаём.
   */
  private async resolveCounterparty(
    workspaceId: string,
    line: RawBankLine,
  ): Promise<string | null> {
    const inn = (line.counterpartyInn ?? '').replace(/\D/g, '');
    const name = line.counterpartyName?.trim();
    if (!inn && !name) return null;

    if (inn) {
      const byInn = await this.prisma.counterparty.findFirst({
        where: { workspaceId, inn, deletedAt: null },
        select: { id: true },
      });
      if (byInn) return byInn.id;
    }
    if (name) {
      const byName = await this.prisma.counterparty.findFirst({
        where: { workspaceId, name: { equals: name, mode: 'insensitive' }, deletedAt: null },
        select: { id: true, inn: true },
      });
      if (byName) {
        // Знакомый контрагент без ИНН — проставим из выписки, дальше он будет
        // матчиться надёжно (и правила по ИНН начнут его ловить).
        if (inn && !byName.inn) {
          await this.prisma.counterparty.update({ where: { id: byName.id }, data: { inn } });
        }
        return byName.id;
      }
    }
    const created = await this.prisma.counterparty.create({
      data: {
        workspaceId,
        name: name || `ИНН ${inn}`,
        inn: inn || null,
        role: line.direction === 'INCOME' ? 'CLIENT' : 'SUPPLIER',
      },
      select: { id: true },
    });
    return created.id;
  }

  /** Данные строки выписки для create — общая часть для авто/ручной ветки. */
  private lineData(
    conn: { id: string; workspaceId: string },
    line: RawBankLine,
    over: {
      status: 'NEW' | 'AUTO_POSTED' | 'RESOLVED';
      suggestedCategoryId: string | null;
      appliedRuleId?: string | null;
      transactionId?: string;
      adopted?: boolean;
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
      appliedRuleId: over.appliedRuleId ?? null,
      adopted: over.adopted ?? false,
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
