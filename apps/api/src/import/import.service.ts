import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OrderService } from '../orders/order.service';
import { AuditService } from '../audit/audit.service';
import type { ImportSource } from '@construct/db';
import { applyRules } from '../category-rule/matcher';
import {
  detectSourceByFilename,
  parseAlfaXlsx,
  parseGenericCsv,
  parseGenericXlsx,
  parseWbPdf,
} from './parsers';
import type { ColumnMapping, ParseResult } from './parsers/types';
import type {
  CommitResult,
  PreviewResult,
  PreviewRow,
  TransferSuggestion,
} from './import.types';
import type { CommitBody } from './import.dto';

/** Окно совпадения дат для детекта пар-переводов в импорте (±дней). */
const TRANSFER_MATCH_WINDOW_DAYS = 3;
const DAY_MS = 86_400_000;

/** Кандидат-контрнога для детекта перевода (транзакция на другом счёте). */
export type TransferCandidate = {
  id: string;
  type: 'INCOME' | 'EXPENSE';
  amount: Prisma.Decimal | string;
  date: Date;
  accountId: string;
  account: { name: string; class: string };
};

/**
 * Чистое ядро детекта перевода: для строки превью находит лучшего кандидата —
 * противоположный тип, та же сумма, дата в пределах windowDays (берём ближайший
 * по дате). Возвращает suggestion или null. Без БД — тестируется юнитом.
 */
export function findTransferMatch(
  row: { type: 'INCOME' | 'EXPENSE'; amount: string; date: string },
  candidates: TransferCandidate[],
  windowDays: number = TRANSFER_MATCH_WINDOW_DAYS,
): TransferSuggestion | null {
  const rowDate = Date.parse(row.date);
  const rowAmount = new Prisma.Decimal(row.amount);
  const wantType = row.type === 'INCOME' ? 'EXPENSE' : 'INCOME';

  const windowMs = windowDays * DAY_MS;
  let best: { c: TransferCandidate; diffMs: number } | null = null;
  for (const c of candidates) {
    if (c.type !== wantType) continue;
    if (!new Prisma.Decimal(c.amount).equals(rowAmount)) continue;
    // Гейт по точным миллисекундам (не по округлённым дням — иначе окно «поплывёт»
    // до ~3.5 дней). daysDiff ниже — округление только для отображения.
    const diffMs = Math.abs(rowDate - c.date.getTime());
    if (diffMs > windowMs) continue;
    if (!best || diffMs < best.diffMs) best = { c, diffMs };
  }
  if (!best) return null;

  return {
    matchedTransactionId: best.c.id,
    otherAccountId: best.c.accountId,
    otherAccountName: best.c.account.name,
    otherAccountClass: best.c.account.class,
    matchedType: best.c.type,
    matchedDate: best.c.date.toISOString(),
    daysDiff: Math.round(best.diffMs / DAY_MS),
  };
}

@Injectable()
export class ImportService {
  constructor(
    private readonly prisma: PrismaService,
    // F3: пересчёт оплаты заказов, к которым привязаны строки выписки.
    private readonly orders: OrderService,
    // GH8/AB6: аудит отката импорта.
    private readonly audit: AuditService,
  ) {}

  computeFileHash(buffer: Buffer): string {
    return createHash('sha256').update(buffer).digest('hex');
  }

  private computeRowHash(input: {
    workspaceId: string;
    accountId: string;
    date: Date;
    amount: string;
    type: 'INCOME' | 'EXPENSE';
    counterpartyName: string | null;
    description: string | null;
  }): string {
    const canonical = [
      input.workspaceId,
      input.accountId,
      input.date.toISOString().slice(0, 10),
      input.amount,
      input.type,
      (input.counterpartyName ?? '').trim().toLowerCase(),
      (input.description ?? '').trim().toLowerCase().slice(0, 80),
    ].join('|');
    return createHash('sha256').update(canonical).digest('hex');
  }

  private async runParser(opts: {
    buffer: Buffer;
    filename: string;
    mimeType?: string;
    source?: ImportSource;
    mapping?: ColumnMapping;
  }): Promise<ParseResult> {
    const source =
      opts.source ?? detectSourceByFilename(opts.filename, opts.mimeType);
    switch (source) {
      case 'ALFA_XLSX':
        return parseAlfaXlsx(opts.buffer);
      case 'WB_PDF':
        return parseWbPdf(opts.buffer);
      case 'GENERIC_XLSX':
        return parseGenericXlsx(opts.buffer, opts.mapping);
      case 'GENERIC_CSV':
        return parseGenericCsv(opts.buffer, opts.mapping);
      case 'TINKOFF_PDF':
        throw new BadRequestException(
          'Тинькофф PDF парсер ещё не реализован — нет фикстуры',
        );
    }
  }

  async preview(opts: {
    workspaceId: string;
    accountId: string;
    buffer: Buffer;
    filename: string;
    mimeType?: string;
    source?: ImportSource;
    mapping?: ColumnMapping;
  }): Promise<PreviewResult> {
    const account = await this.prisma.account.findFirst({
      where: { id: opts.accountId, workspaceId: opts.workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!account) throw new NotFoundException('Account not found');

    const parsed = await this.runParser(opts);

    const cpNames = Array.from(
      new Set(
        parsed.rows
          .map((r) => r.counterpartyName?.trim())
          .filter((n): n is string => !!n)
          .map((n) => n.toLowerCase()),
      ),
    );
    const existingCps =
      cpNames.length > 0
        ? await this.prisma.counterparty.findMany({
            where: {
              workspaceId: opts.workspaceId,
              deletedAt: null,
              name: { in: cpNames, mode: 'insensitive' },
            },
            select: { id: true, name: true },
          })
        : [];
    const cpByLcName = new Map<string, string>();
    for (const cp of existingCps) cpByLcName.set(cp.name.toLowerCase(), cp.id);

    const rules = await this.prisma.categoryRule.findMany({
      where: { workspaceId: opts.workspaceId, isActive: true, deletedAt: null },
      select: { keyword: true, categoryId: true, priority: true, category: { select: { kind: true } } },
    });

    const previewRows: PreviewRow[] = [];
    let invalidCount = 0;
    for (const r of parsed.rows) {
      if (!r.date || !r.amount || !r.type) {
        invalidCount++;
        continue;
      }
      const importHash = this.computeRowHash({
        workspaceId: opts.workspaceId,
        accountId: opts.accountId,
        date: r.date,
        amount: r.amount,
        type: r.type,
        counterpartyName: r.counterpartyName,
        description: r.description,
      });
      const suggestedCategoryId = applyRules(
        rules.map((rule) => ({
          keyword: rule.keyword,
          categoryId: rule.categoryId,
          priority: rule.priority,
          kind: rule.category.kind,
        })),
        {
          description: r.description,
          counterpartyName: r.counterpartyName,
          kind: r.type,
        },
      );
      previewRows.push({
        rawIndex: r.rawIndex,
        date: r.date.toISOString(),
        amount: r.amount,
        type: r.type,
        description: r.description,
        counterpartyName: r.counterpartyName,
        resolvedCounterpartyId: r.counterpartyName
          ? cpByLcName.get(r.counterpartyName.trim().toLowerCase()) ?? null
          : null,
        suggestedCategoryId,
        importHash,
        isDuplicate: false,
        transferSuggestion: null,
        errors: r.errors,
        raw: r.raw,
      });
    }

    if (previewRows.length > 0) {
      const dupTxs = await this.prisma.transaction.findMany({
        where: {
          workspaceId: opts.workspaceId,
          importHash: { in: previewRows.map((r) => r.importHash) },
          deletedAt: null,
        },
        select: { importHash: true },
      });
      const dupSet = new Set(
        dupTxs.map((t) => t.importHash).filter((h): h is string => !!h),
      );
      for (const r of previewRows) {
        if (dupSet.has(r.importHash)) r.isDuplicate = true;
      }
    }

    await this.annotateTransferSuggestions(opts.workspaceId, opts.accountId, previewRows);

    return {
      source: parsed.source,
      headers: parsed.headers,
      suggestedMapping: parsed.suggestedMapping,
      encoding: parsed.encoding,
      filename: opts.filename,
      fileHash: this.computeFileHash(opts.buffer),
      rows: previewRows,
      stats: {
        total: parsed.rows.length,
        valid: previewRows.length,
        invalid: invalidCount,
        duplicates: previewRows.filter((r) => r.isDuplicate).length,
      },
    };
  }

  /**
   * Помечает строки превью, похожие на ногу внутреннего перевода: ищем на ДРУГИХ
   * счетах workspace существующую транзакцию-контрногу (противоположный тип, та
   * же сумма, дата в пределах TRANSFER_MATCH_WINDOW_DAYS), которая ещё НЕ часть
   * перевода (transferGroupId=null). Один батч-запрос на все строки. Это лишь
   * suggestion для UI — сам перевод создаётся через API переводов (Полоса A).
   */
  private async annotateTransferSuggestions(
    workspaceId: string,
    importAccountId: string,
    rows: PreviewRow[],
  ): Promise<void> {
    if (rows.length === 0) return;

    // Окно батч-запроса — НАДмножество кандидатов: union по всем строкам
    // [r−W, r+W] = [minRowDate−W, maxRowDate+W]. Точная проверка ±W для каждой
    // строки делается в findTransferMatch, так что лишние кандидаты отсекутся там.
    const windowMs = TRANSFER_MATCH_WINDOW_DAYS * DAY_MS;
    // Спред Math.min/max(...dates) роняет стек на больших импортах (десятки тысяч
    // строк → `apply` с огромным числом аргументов). Считаем границы линейным
    // проходом без spread. NaN-даты (нераспознанные) пропускаем, не отравляя min/max.
    let minMs = Number.POSITIVE_INFINITY;
    let maxMs = Number.NEGATIVE_INFINITY;
    for (const r of rows) {
      const t = Date.parse(r.date);
      if (Number.isNaN(t)) continue;
      if (t < minMs) minMs = t;
      if (t > maxMs) maxMs = t;
    }
    if (!Number.isFinite(minMs) || !Number.isFinite(maxMs)) return;
    const minDate = new Date(minMs - windowMs);
    const maxDate = new Date(maxMs + windowMs);
    const amounts = Array.from(new Set(rows.map((r) => r.amount))).map(
      (a) => new Prisma.Decimal(a),
    );

    const candidates = (await this.prisma.transaction.findMany({
      where: {
        workspaceId,
        accountId: { not: importAccountId },
        deletedAt: null,
        transferGroupId: null,
        amount: { in: amounts },
        date: { gte: minDate, lte: maxDate },
      },
      select: {
        id: true,
        type: true,
        amount: true,
        date: true,
        accountId: true,
        account: { select: { name: true, class: true } },
      },
    })) as TransferCandidate[];
    if (candidates.length === 0) return;

    for (const row of rows) {
      row.transferSuggestion = findTransferMatch(row, candidates, TRANSFER_MATCH_WINDOW_DAYS);
    }
  }

  async commit(opts: {
    workspaceId: string;
    userId: string;
    body: CommitBody;
  }): Promise<CommitResult> {
    const { body, workspaceId, userId } = opts;

    const account = await this.prisma.account.findFirst({
      where: { id: body.accountId, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!account) throw new NotFoundException('Account not found');

    // Cross-tenant guard: categoryId строк берётся из тела запроса. Без проверки
    // принадлежности workspace можно повесить на свои проводки чужую категорию
    // (утечка имени в отчёты by-category, порча группировок). Счёт уже проверен выше.
    const categoryIds = Array.from(
      new Set(body.rows.map((r) => r.categoryId).filter((c): c is string => !!c)),
    );
    if (categoryIds.length > 0) {
      const found = await this.prisma.category.findMany({
        where: { id: { in: categoryIds }, workspaceId, deletedAt: null },
        select: { id: true, kind: true },
      });
      if (found.length !== categoryIds.length) {
        throw new BadRequestException('Категория не найдена в этом пространстве');
      }
      // C16: категория расхода не должна попадать на приходную строку (и наоборот)
      // — иначе операция уедет в чужой бакет P&L. Сверяем построчно по kind↔type.
      const kindById = new Map(found.map((c) => [c.id, c.kind]));
      for (const r of body.rows) {
        if (r.categoryId && kindById.get(r.categoryId) !== r.type) {
          throw new BadRequestException(
            `Строка «${r.description ?? r.amount}»: категория не соответствует типу операции (${r.type})`,
          );
        }
      }
    }

    const rowsToImport = body.skipDuplicates
      ? body.rows.filter((r) => !r.isDuplicate)
      : body.rows;
    const skipped = body.rows.length - rowsToImport.length;

    if (rowsToImport.length === 0) {
      throw new BadRequestException('Nothing to import — all rows are duplicates');
    }

    // F3 (5d): привязка строк к заказам. Cross-tenant guard + валидация:
    // привязывать можно только ПРИХОД (оплата заказа) и только к живому заказу.
    const orderIds = Array.from(
      new Set(rowsToImport.map((r) => r.orderId).filter((o): o is string => !!o)),
    );
    if (orderIds.length > 0) {
      for (const r of rowsToImport) {
        if (r.orderId && r.type !== 'INCOME') {
          throw new BadRequestException(
            'К заказу можно привязать только приходную строку (оплату)',
          );
        }
      }
    }

    // Дедуп контрагентов по lowercase-ключу, а НЕ по точному регистру: иначе
    // «Ромашка» и «РОМАШКА» из одного файла попадали бы в namesNeeded оба и
    // createMany завёл бы два отдельных контрагента (дубли пачкают отчёты
    // by-counterparty и авто-резолв). Храним первое встреченное написание как
    // каноническое. (DB-бэкстоп — партиал-unique по (workspaceId, lower(name)) —
    // остаётся отдельной миграцией, см. заметку в отчёте.)
    const canonicalByLc = new Map<string, string>();
    for (const r of rowsToImport) {
      const n = r.counterpartyName?.trim();
      if (!n) continue;
      const lc = n.toLowerCase();
      if (!canonicalByLc.has(lc)) canonicalByLc.set(lc, n);
    }
    const namesNeeded = Array.from(canonicalByLc.values());
    const existing =
      namesNeeded.length > 0
        ? await this.prisma.counterparty.findMany({
            where: {
              workspaceId,
              deletedAt: null,
              name: {
                in: namesNeeded.map((n) => n.toLowerCase()),
                mode: 'insensitive',
              },
            },
            select: { id: true, name: true },
          })
        : [];
    const cpByLcName = new Map<string, string>();
    for (const cp of existing) cpByLcName.set(cp.name.toLowerCase(), cp.id);

    return this.prisma.$transaction(async (tx) => {
      // F3: валидация заказов ПОД транзакцией (TOCTOU — параллельная отмена
      // между проверкой и вставкой), паттерн assertAccountTx.
      const orderById = new Map<
        string,
        { clientId: string | null; status: string; number: string }
      >();
      if (orderIds.length > 0) {
        const foundOrders = await tx.order.findMany({
          where: { id: { in: orderIds }, workspaceId, deletedAt: null },
          select: { id: true, clientId: true, status: true, number: true },
        });
        if (foundOrders.length !== orderIds.length) {
          throw new BadRequestException('Заказ не найден в этом пространстве');
        }
        for (const o of foundOrders) {
          if (o.status === 'CANCELLED') {
            throw new BadRequestException(
              `Заказ ${o.number} отменён — привязать оплату нельзя`,
            );
          }
          orderById.set(o.id, o);
        }
      }

      // Защита от повторного импорта того же файла: внутри транзакции проверяем,
      // что батч с этим fileHash ещё не заводился (Фаза 4 п.18). Дополняет
      // строковый partial-unique по importHash (п.17): даёт понятный ранний отказ
      // вместо отката по дублю на середине вставки.
      const dupBatch = await tx.importBatch.findFirst({
        where: { workspaceId, fileHash: body.fileHash, deletedAt: null },
        select: { id: true },
      });
      if (dupBatch) {
        throw new ConflictException(
          'Этот файл уже импортирован (совпал fileHash). Удалите прежний импорт, чтобы повторить.',
        );
      }

      // Недостающие контрагенты — одним createMany вместо N последовательных
      // create. createMany не возвращает id, поэтому после вставки до-вычитываем
      // только созданные имена и достраиваем карту name→id.
      const toCreate = namesNeeded.filter((n) => !cpByLcName.has(n.toLowerCase()));
      if (toCreate.length > 0) {
        await tx.counterparty.createMany({
          data: toCreate.map((name) => ({ workspaceId, name })),
        });
        const created = await tx.counterparty.findMany({
          where: {
            workspaceId,
            deletedAt: null,
            name: { in: toCreate.map((n) => n.toLowerCase()), mode: 'insensitive' },
          },
          select: { id: true, name: true },
        });
        for (const cp of created) cpByLcName.set(cp.name.toLowerCase(), cp.id);
      }

      const batch = await tx.importBatch.create({
        data: {
          workspaceId,
          userId,
          source: body.source,
          filename: body.filename,
          fileHash: body.fileHash,
          rowsTotal: body.rows.length,
          rowsImported: rowsToImport.length,
          rowsSkipped: skipped,
        },
      });

      // Проводки — одним createMany вместо N последовательных INSERT (для выписки
      // на тысячи строк это тысячи round-trip → один батч). Partial-unique по
      // importHash остаётся: дубль внутри батча/повтор файла откатит транзакцию.
      await tx.transaction.createMany({
        data: rowsToImport.map((r) => {
          // F3: привязанная строка — оплата заказа: kind=ORDER_PAYMENT, контрагент =
          // клиент заказа КАК ЕСТЬ (включая null для заказа без клиента — семантика
          // addPayment; банк/эквайер из выписки контрагентом оплаты не становится).
          const order = r.orderId ? orderById.get(r.orderId) : undefined;
          return {
            workspaceId,
            accountId: body.accountId,
            date: new Date(r.date),
            amount: r.amount,
            type: r.type,
            ...(order ? { kind: 'ORDER_PAYMENT' as const, orderId: r.orderId } : {}),
            description: r.description,
            counterpartyId: order
              ? order.clientId
              : r.counterpartyName
                ? cpByLcName.get(r.counterpartyName.trim().toLowerCase()) ?? null
                : null,
            categoryId: r.categoryId,
            importBatchId: batch.id,
            importHash: r.importHash,
            createdById: userId,
          };
        }),
      });

      // F3: у привязанных заказов пересчитываем оплату в ЭТОЙ ЖЕ транзакции —
      // paidAmount/paymentStatus консистентны с созданными проводками.
      for (const orderId of orderById.keys()) {
        await this.orders.recalcPaymentState(workspaceId, orderId, tx);
      }

      return {
        batchId: batch.id,
        imported: rowsToImport.length,
        skipped,
      };
    });
  }

  async listBatches(workspaceId: string) {
    return this.prisma.importBatch.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        source: true,
        filename: true,
        rowsTotal: true,
        rowsImported: true,
        rowsSkipped: true,
        createdAt: true,
        deletedAt: true,
        user: { select: { firstName: true, username: true } },
      },
    });
  }

  /**
   * GH8 (Волна 2, обратимость): откат импортированной выписки целиком. Раньше
   * ошибочный импорт (не тот файл / не тот счёт / не те привязки к заказам) нельзя
   * было отменить одним действием — только вручную по проводке, а привязанные
   * оплаты заказов оставались призрачными. Теперь soft-delete всех проводок батча
   * + soft-delete самого батча + ПЕРЕИГРОВКА recalcPaymentState затронутых
   * заказов (paidAmount/статус возвращаются к состоянию до импорта). Всё в одной
   * транзакции — либо весь откат, либо ничего.
   *
   * После отката partial-unique по importHash/fileHash (WHERE deletedAt IS NULL)
   * освобождается → тот же файл можно импортировать заново.
   */
  async revertBatch(workspaceId: string, batchId: string, userId: string) {
    return this.prisma.$transaction(async (tx) => {
      const batch = await tx.importBatch.findFirst({
        where: { id: batchId, workspaceId, deletedAt: null },
        select: { id: true, filename: true, rowsImported: true },
      });
      if (!batch) throw new NotFoundException('Импорт не найден или уже отменён');

      // Затронутые заказы — до soft-delete (после проводки станут deletedAt и
      // из выборки выпадут). Только привязанные оплаты (orderId != null).
      const linked = await tx.transaction.findMany({
        where: { workspaceId, importBatchId: batchId, deletedAt: null, orderId: { not: null } },
        select: { orderId: true },
        distinct: ['orderId'],
      });
      const orderIds = linked.map((t) => t.orderId).filter((x): x is string => !!x);

      const del = await tx.transaction.updateMany({
        where: { workspaceId, importBatchId: batchId, deletedAt: null },
        data: { deletedAt: new Date() },
      });

      await tx.importBatch.update({
        where: { id: batchId },
        data: { deletedAt: new Date() },
      });

      // Переигровка оплаты заказов — после того как их импортные проводки скрыты.
      for (const orderId of orderIds) {
        await this.orders.recalcPaymentState(workspaceId, orderId, tx);
      }

      await this.audit.record(tx, {
        workspaceId,
        actorId: userId,
        action: 'import.revert',
        entityType: 'ImportBatch',
        entityId: batchId,
        diff: {
          filename: batch.filename,
          reverted: del.count,
          ordersRecalced: orderIds.length,
        },
      });

      return { reverted: del.count, ordersRecalced: orderIds.length };
    });
  }
}
