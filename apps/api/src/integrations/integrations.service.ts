import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from './crypto.service';
import { SyncService, type SyncResult } from './sync.service';
import type { CreateIntegrationDto, UpdateIntegrationDto } from './integrations.dto';
import { AuditService } from '../audit/audit.service';
import { parseTlsCredential, serializeTlsCredential } from './tls-credential';

// Публичная выборка — credentialEnc НАМЕРЕННО не выбирается: секрет не покидает
// слой БД (defense-in-depth, а не только фильтрация в serialize).
const PUBLIC_SELECT = {
  id: true,
  provider: true,
  status: true,
  keyLast4: true,
  externalAccountId: true,
  // Сам сертификат (tlsCredentialEnc) НЕ выбираем — наружу идут только
  // публичные метаданные: какой сертификат стоит и до какого числа он годен.
  tlsFingerprint: true,
  tlsExpiresAt: true,
  backfillFrom: true,
  syncCursor: true,
  lastSyncAt: true,
  lastSyncError: true,
  bankBalance: true,
  bankBalanceAt: true,
  createdAt: true,
  account: { select: { id: true, name: true } },
} satisfies Prisma.IntegrationConnectionSelect;

/**
 * CRUD банковских подключений + ручной запуск синка (Ф1-C). Секрет
 * (токен) наружу никогда не отдаётся — только маска keyLast4. Доступ
 * гейтится OwnerGuard на контроллере (только владелец пространства).
 */
@Injectable()
export class IntegrationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly sync: SyncService,
    private readonly audit: AuditService,
  ) {}

  async list(workspaceId: string) {
    const rows = await this.prisma.integrationConnection.findMany({
      where: { workspaceId, deletedAt: null },
      select: PUBLIC_SELECT,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.serialize(r));
  }

  async create(workspaceId: string, userId: string, dto: CreateIntegrationDto) {
    await this.assertAccount(workspaceId, dto.accountId);
    // encrypt бросит 503, если INTEGRATION_MASTER_KEY не задан — фича выключена.
    const credentialEnc = this.crypto.encrypt(dto.token);
    const tls = this.buildTls(dto);
    const created = await this.prisma.integrationConnection.create({
      data: {
        workspaceId,
        provider: dto.provider,
        accountId: dto.accountId,
        credentialEnc,
        keyLast4: CryptoService.mask(dto.token),
        externalAccountId: dto.accountNumber ?? null,
        // Дату можно задать сразу при подключении — тогда первый же синк пойдёт
        // за историей, а не только за операциями с сегодняшнего дня.
        backfillFrom: dto.backfillFrom ?? null,
        ...tls,
        createdById: userId,
      },
      select: PUBLIC_SELECT,
    });
    // Аудит подключения банка: значение секрета НЕ пишем — только провайдер,
    // счёт и маска. Раньше самые security-значимые операции не оставляли следа.
    await this.audit.record(undefined, {
      workspaceId,
      actorId: userId,
      action: 'integration.create',
      entityType: 'IntegrationConnection',
      entityId: created.id,
      diff: {
        provider: dto.provider,
        accountId: dto.accountId,
        keyLast4: created.keyLast4,
        // Номер счёта — в аудит маской: сам реквизит в этой таблице не нужен.
        accountNumberLast4: dto.accountNumber ? dto.accountNumber.slice(-4) : null,
        // Сертификат — только отпечаток (публичная часть), никогда не ключ.
        tlsFingerprint: created.tlsFingerprint,
      },
    });
    return this.serialize(created);
  }

  async update(workspaceId: string, id: string, userId: string, dto: UpdateIntegrationDto) {
    const existing = await this.assertOwned(workspaceId, id);
    const updated = await this.prisma.integrationConnection.update({
      where: { id },
      data: {
        ...(dto.token
          ? {
              credentialEnc: this.crypto.encrypt(dto.token),
              keyLast4: CryptoService.mask(dto.token),
              // Ротация токена сбрасывает прошлую ошибку — даём синку шанс.
              status: 'ACTIVE',
              lastSyncError: null,
            }
          : {}),
        ...(dto.status ? { status: dto.status } : {}),
        // Смена номера счёта = другой источник строк: курсор прошлого счёта
        // больше не значит ничего, тянем заново с даты подключения. Дубли
        // невозможны — идемпотентность по (connectionId, externalId).
        ...(dto.accountNumber
          ? { externalAccountId: dto.accountNumber, syncCursor: null, lastSyncError: null }
          : {}),
        // Замена сертификата (ротация по сроку или переход на боевой после
        // песочницы) — как и ротация токена, сбрасывает прошлую ошибку.
        ...(dto.tlsCert ? { ...this.buildTls(dto), status: 'ACTIVE', lastSyncError: null } : {}),
        // Сдвиг даты выгрузки НАЗАД обязан сбросить курсор: иначе синк продолжит
        // с уже пройденного места и прошлое так и не приедет. Сдвиг вперёд курсор
        // не трогает — уже загруженное остаётся, просто дальше не углубляемся.
        ...(dto.backfillFrom !== undefined
          ? {
              backfillFrom: dto.backfillFrom,
              ...(this.movesBackfillEarlier(dto.backfillFrom, existing)
                ? { syncCursor: null, lastSyncError: null }
                : {}),
            }
          : {}),
      },
      select: PUBLIC_SELECT,
    });
    if (dto.token) {
      await this.audit.record(undefined, {
        workspaceId,
        actorId: userId,
        action: 'integration.token-rotate',
        entityType: 'IntegrationConnection',
        entityId: id,
        // Только маска нового ключа — сам токен в аудит не попадает.
        diff: { provider: updated.provider, keyLast4: updated.keyLast4 },
      });
    }
    if (dto.accountNumber) {
      await this.audit.record(undefined, {
        workspaceId,
        actorId: userId,
        action: 'integration.account-change',
        entityType: 'IntegrationConnection',
        entityId: id,
        diff: { accountNumberLast4: dto.accountNumber.slice(-4), syncCursorReset: true },
      });
    }
    if (dto.tlsCert) {
      await this.audit.record(undefined, {
        workspaceId,
        actorId: userId,
        action: 'integration.tls-rotate',
        entityType: 'IntegrationConnection',
        entityId: id,
        // Отпечаток и срок — публичная часть сертификата; ключ в аудит не идёт.
        diff: {
          tlsFingerprint: updated.tlsFingerprint,
          tlsExpiresAt: updated.tlsExpiresAt?.toISOString() ?? null,
        },
      });
    }
    if (dto.status) {
      await this.audit.record(undefined, {
        workspaceId,
        actorId: userId,
        action: 'integration.disable',
        entityType: 'IntegrationConnection',
        entityId: id,
        diff: { status: dto.status },
      });
    }
    return this.serialize(updated);
  }

  async softDelete(workspaceId: string, id: string, userId: string) {
    await this.assertOwned(workspaceId, id);
    await this.prisma.integrationConnection.update({
      where: { id },
      data: { deletedAt: new Date(), status: 'DISABLED' },
    });
    await this.audit.record(undefined, {
      workspaceId,
      actorId: userId,
      action: 'integration.disable',
      entityType: 'IntegrationConnection',
      entityId: id,
      diff: { deleted: true },
    });
  }

  /** Ручной синк «обновить сейчас» (решение №12). */
  async syncNow(workspaceId: string, id: string): Promise<SyncResult> {
    await this.assertOwned(workspaceId, id);
    return this.sync.syncConnection(id);
  }

  /**
   * «Перезагрузить выписку»: снести всё, что приехало из банка по этому
   * подключению, и обнулить курсор — следующий синк вытянет операции заново, по
   * актуальным правилам автокатегоризации и актуальному маппингу адаптера.
   *
   * Нужен, когда правила завели уже ПОСЛЕ первого синка: иначе строки навсегда
   * остались бы разобранными по-старому, а повторно банк их не отдаст —
   * идемпотентность по (connectionId, externalId) не пустит.
   *
   * Что НЕ трогаем:
   *   • оплаты заказов (kind != OTHER) — за ними стоят paidAmount и статус
   *     заказа, снимать их молча нельзя (решение владельца). Их строки выписки
   *     тоже остаются: удалив строку, мы открыли бы дорогу повторному втягиванию
   *     той же операции и второй оплате того же заказа;
   *   • операции, заведённые руками — они с выпиской не связаны вовсе.
   *
   * Проводки снимаются soft-delete (правило проекта), строки выписки удаляются
   * физически: это staging-слой, его смысл — быть перезагружаемым.
   */
  async resetStatement(workspaceId: string, id: string, userId: string) {
    await this.assertOwned(workspaceId, id);

    const lines = await this.prisma.bankStatementLine.findMany({
      where: { connectionId: id },
      select: { id: true, transaction: { select: { id: true, kind: true } } },
    });

    // Оставляем строку, если из неё родилась НЕ обычная проводка: сейчас это
    // оплаты заказов (ORDER_PAYMENT), у которых свои инварианты.
    const isOrderPayment = (l: (typeof lines)[number]) =>
      l.transaction !== null && l.transaction.kind !== 'OTHER';
    const keep = lines.filter(isOrderPayment);
    const drop = lines.filter((l) => !isOrderPayment(l));
    const txToRemove = drop.flatMap((l) => (l.transaction ? [l.transaction.id] : []));

    await this.prisma.$transaction(async (tx) => {
      if (txToRemove.length > 0) {
        await tx.transaction.updateMany({
          where: { id: { in: txToRemove }, workspaceId, deletedAt: null },
          data: { deletedAt: new Date() },
        });
      }
      if (drop.length > 0) {
        await tx.bankStatementLine.deleteMany({ where: { id: { in: drop.map((l) => l.id) } } });
      }
      await tx.integrationConnection.update({
        where: { id },
        data: { syncCursor: null, lastSyncError: null, status: 'ACTIVE' },
      });
    });

    await this.audit.record(undefined, {
      workspaceId,
      actorId: userId,
      action: 'integration.reset',
      entityType: 'IntegrationConnection',
      entityId: id,
      diff: {
        linesDeleted: drop.length,
        transactionsRemoved: txToRemove.length,
        orderPaymentsKept: keep.length,
      },
    });

    return {
      linesDeleted: drop.length,
      transactionsRemoved: txToRemove.length,
      orderPaymentsKept: keep.length,
    };
  }

  /**
   * Готовит поля сертификата к записи: валидирует PEM, достаёт публичные
   * метаданные и шифрует пару cert+key. Пустой объект, если сертификат не
   * загружали (Т-Банк, либо Альфа на сертификате из env).
   */
  private buildTls(dto: { tlsCert?: string; tlsKey?: string; tlsPassphrase?: string }) {
    if (!dto.tlsCert || !dto.tlsKey) return {};
    const credential = {
      cert: dto.tlsCert,
      key: dto.tlsKey,
      ...(dto.tlsPassphrase ? { passphrase: dto.tlsPassphrase } : {}),
    };
    const meta = parseTlsCredential(credential);
    return {
      tlsCredentialEnc: this.crypto.encrypt(serializeTlsCredential(credential)),
      tlsFingerprint: meta.fingerprint,
      tlsExpiresAt: meta.expiresAt,
    };
  }

  private async assertAccount(workspaceId: string, accountId: string) {
    const account = await this.prisma.account.findFirst({
      where: { id: accountId, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!account) throw new BadRequestException('Счёт не найден в этом пространстве');
  }

  private async assertOwned(workspaceId: string, id: string) {
    const conn = await this.prisma.integrationConnection.findFirst({
      where: { id, workspaceId, deletedAt: null },
      select: { id: true, backfillFrom: true, createdAt: true },
    });
    if (!conn) throw new NotFoundException('Подключение не найдено');
    return conn;
  }

  /**
   * Стало ли начало выгрузки раньше прежнего? Точкой отсчёта, когда backfillFrom
   * не был задан, служит дата подключения — синк стартовал именно с неё.
   */
  private movesBackfillEarlier(
    next: Date | null | undefined,
    existing: { backfillFrom: Date | null; createdAt: Date },
  ): boolean {
    // Снятие даты возвращает старт к дате подключения — это всегда «позже или
    // так же», курсор трогать незачем.
    if (next == null) return false;
    const current = existing.backfillFrom ?? existing.createdAt;
    return next.getTime() < current.getTime();
  }

  /** Публичная форма — БЕЗ credentialEnc (секрет наружу не уходит). */
  private serialize(r: {
    id: string;
    provider: string;
    status: string;
    /** Null у файловых подключений — ключа там нет вовсе. */
    keyLast4: string | null;
    externalAccountId: string | null;
    tlsFingerprint: string | null;
    tlsExpiresAt: Date | null;
    backfillFrom: Date | null;
    syncCursor: string | null;
    lastSyncAt: Date | null;
    lastSyncError: string | null;
    bankBalance: Prisma.Decimal | null;
    bankBalanceAt: Date | null;
    createdAt: Date;
    account: { id: string; name: string };
  }) {
    return {
      id: r.id,
      provider: r.provider,
      status: r.status,
      keyLast4: r.keyLast4,
      accountNumber: r.externalAccountId,
      // Публичная часть сертификата: показать, какой стоит и когда истекает.
      tlsFingerprint: r.tlsFingerprint,
      tlsExpiresAt: r.tlsExpiresAt?.toISOString() ?? null,
      backfillFrom: r.backfillFrom?.toISOString() ?? null,
      account: r.account,
      lastSyncAt: r.lastSyncAt?.toISOString() ?? null,
      lastSyncError: r.lastSyncError,
      // Остаток по данным банка на последнем синке — «по банку» на карточке.
      bankBalance: r.bankBalance ? r.bankBalance.toFixed(2) : null,
      bankBalanceAt: r.bankBalanceAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
