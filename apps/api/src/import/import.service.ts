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
import { applyRules, type RuleCondition, type RuleAction } from '../rule/engine';
import { computeRowHash } from '../common/import-hash';
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

  /** Отпечаток строки; общий с банк-синком — см. common/import-hash.ts. */
  private computeRowHash(input: {
    workspaceId: string;
    accountId: string;
    date: Date;
    amount: string;
    type: 'INCOME' | 'EXPENSE';
    counterpartyName: string | null;
    description: string | null;
  }): string {
    return computeRowHash(input);
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

    // Подсказки категории при импорте даёт единый движок правил (Rule). Грузим
    // один раз применимые к импорту активные правила, дальше гоняем чистый
    // движок per-row.
    const ruleRows = await this.prisma.rule.findMany({
      where: {
        workspaceId: opts.workspaceId,
        isActive: true,
        deletedAt: null,
        appliesTo: { in: ['IMPORT', 'BOTH'] },
      },
      select: { id: true, name: true, priority: true, conditions: true, actions: true },
    });
    const rules = ruleRows.map((r) => ({
      id: r.id,
      name: r.name,
      priority: r.priority,
      conditions: r.conditions as unknown as RuleCondition[],
      actions: r.actions as unknown as RuleAction[],
    }));

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
      // Движок отдаёт полную подсказку (категория/контрагент/счёт); импорт-превью
      // использует только категорию — контрагент резолвится по имени отдельно
      // (cpByLcName), счёт задаётся выбором пользователя. source='IMPORT' сужает
      // правила и включает условие SOURCE_EQUALS.
      const suggestion = applyRules(rules, {
        description: r.description,
        counterpartyName: r.counterpartyName,
        type: r.type,
        // Сумма и счёт известны здесь же (importHash выше считается по ним) — без них
        // условия AMOUNT_RANGE и ACCOUNT_EQUALS в импорте не срабатывали никогда.
        amount: r.amount,
        accountId: opts.accountId,
        source: 'IMPORT',
      });
      const suggestedCategoryId = suggestion.categoryId ?? null;
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
        receiptMatch: null,
        errors: r.errors,
        raw: r.raw,
      });
    }

    if (previewRows.length > 0) {
      const hashes = previewRows.map((r) => r.importHash);
      // Дубли ищем в двух местах. Строки «Входящих» — то, что кладёт импорт
      // сейчас. Проводки с importHash — наследие прежнего поведения (файл сразу
      // создавал операции); без этой половины повторная загрузка старого файла
      // завела бы вторую копию тех же денег.
      const [dupLines, dupTxs] = await Promise.all([
        this.prisma.bankStatementLine.findMany({
          where: { workspaceId: opts.workspaceId, externalId: { in: hashes } },
          select: { externalId: true },
        }),
        this.prisma.transaction.findMany({
          where: {
            workspaceId: opts.workspaceId,
            importHash: { in: hashes },
            deletedAt: null,
          },
          select: { importHash: true },
        }),
      ]);
      const dupSet = new Set<string>(dupLines.map((l) => l.externalId));
      for (const t of dupTxs) if (t.importHash) dupSet.add(t.importHash);
      for (const r of previewRows) {
        if (dupSet.has(r.importHash)) r.isDuplicate = true;
      }
    }

    await this.annotateTransferSuggestions(opts.workspaceId, opts.accountId, previewRows);
    await this.annotateReceiptMatches(opts.workspaceId, opts.accountId, previewRows);

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

  /** Окно матча строки выписки с расходом, созданным разбором чека WB (±дней). */
  private static readonly RECEIPT_MATCH_WINDOW_DAYS = 2;

  /**
   * Ф6 (анти-задвоение): помечает EXPENSE-строки превью, чей расход уже
   * СОЗДАН разбором чека WB на этом же счёте (сумма равна, дата ± 2 дня —
   * списание в выписке может отставать от даты чека). Привязанные операции
   * (transactionCreated=false) не метятся: их источник — сама выписка.
   * Один батч-запрос на все строки, точная проверка окна per-row.
   */
  private async annotateReceiptMatches(
    workspaceId: string,
    accountId: string,
    rows: PreviewRow[],
  ): Promise<void> {
    const expenseRows = rows.filter((r) => r.type === 'EXPENSE');
    if (expenseRows.length === 0) return;

    const windowMs = ImportService.RECEIPT_MATCH_WINDOW_DAYS * DAY_MS;
    let minMs = Number.POSITIVE_INFINITY;
    let maxMs = Number.NEGATIVE_INFINITY;
    for (const r of expenseRows) {
      const t = Date.parse(r.date);
      if (Number.isNaN(t)) continue;
      if (t < minMs) minMs = t;
      if (t > maxMs) maxMs = t;
    }
    if (!Number.isFinite(minMs) || !Number.isFinite(maxMs)) return;
    const amounts = Array.from(new Set(expenseRows.map((r) => r.amount))).map(
      (a) => new Prisma.Decimal(a),
    );

    const candidates = await this.prisma.transaction.findMany({
      where: {
        workspaceId,
        accountId,
        deletedAt: null,
        type: 'EXPENSE',
        amount: { in: amounts },
        date: { gte: new Date(minMs - windowMs), lte: new Date(maxMs + windowMs) },
        wbReceipt: { is: { deletedAt: null, transactionCreated: true } },
      },
      select: {
        id: true,
        amount: true,
        date: true,
        wbReceipt: { select: { id: true } },
      },
    });
    if (candidates.length === 0) return;

    for (const row of expenseRows) {
      const rowMs = Date.parse(row.date);
      const rowAmount = new Prisma.Decimal(row.amount);
      const hit = candidates.find(
        (c) =>
          c.amount.equals(rowAmount) && Math.abs(rowMs - c.date.getTime()) <= windowMs,
      );
      if (hit && hit.wbReceipt) {
        row.receiptMatch = { receiptId: hit.wbReceipt.id, transactionId: hit.id };
      }
    }
  }

  /**
   * Подключение, в которое ложится файловая выписка счёта. Нужно потому, что
   * строка «Входящих» без подключения не существует (connectionId обязателен), а
   * счёт вроде карты ВБ банк по API не отдаёт вовсе. Первый импорт на счёт
   * заводит подключение сам — отдельного шага настройки для этого нет смысла
   * требовать. Токена у него нет, адаптера тоже: синк такие подключения
   * пропускает (см. syncAllActive), выписку приносит только импорт.
   */
  private async resolveFileConnection(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    accountId: string,
    userId: string,
  ): Promise<string> {
    const existing = await tx.integrationConnection.findFirst({
      where: { workspaceId, accountId, provider: 'FILE', deletedAt: null },
      select: { id: true },
    });
    if (existing) return existing.id;

    const created = await tx.integrationConnection.create({
      data: {
        workspaceId,
        accountId,
        provider: 'FILE',
        // Ключа нет: выписку приносит человек файлом, а не токен по сети.
        credentialEnc: null,
        keyLast4: null,
        status: 'ACTIVE',
        createdById: userId,
      },
      select: { id: true },
    });
    return created.id;
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

    const rowsToImport = body.skipDuplicates
      ? body.rows.filter((r) => !r.isDuplicate)
      : body.rows;
    const skipped = body.rows.length - rowsToImport.length;

    if (rowsToImport.length === 0) {
      throw new BadRequestException('Импортировать нечего — все строки дубликаты');
    }

    // Подсказку категории считаем на сервере, а не берём из тела запроса: превью
    // теперь только показывает, что распозналось, и разметку не собирает. Строку
    // проводит человек во «Входящих» — подсказка ему помогает, но ничего не решает.
    const ruleRows = await this.prisma.rule.findMany({
      where: {
        workspaceId,
        isActive: true,
        deletedAt: null,
        appliesTo: { in: ['IMPORT', 'BOTH'] },
      },
      select: { id: true, name: true, priority: true, conditions: true, actions: true },
    });
    const rules = ruleRows.map((r) => ({
      id: r.id,
      name: r.name,
      priority: r.priority,
      conditions: r.conditions as unknown as RuleCondition[],
      actions: r.actions as unknown as RuleAction[],
    }));

    return this.prisma.$transaction(async (tx) => {
      // Защита от повторного импорта того же файла: внутри транзакции проверяем,
      // что батч с этим fileHash ещё не заводился (Фаза 4 п.18). Дополняет
      // уникальность (connectionId, externalId): даёт понятный ранний отказ
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

      const connectionId = await this.resolveFileConnection(
        tx,
        workspaceId,
        body.accountId,
        userId,
      );

      // Строки — одним createMany вместо N последовательных INSERT (для выписки
      // на тысячи строк это тысячи round-trip → один батч). externalId = importHash:
      // тот же отпечаток, по которому превью метит дубликаты, и уникальность
      // (connectionId, externalId) не даёт завести строку дважды.
      await tx.bankStatementLine.createMany({
        data: rowsToImport.map((r) => ({
          workspaceId,
          connectionId,
          externalId: r.importHash,
          date: new Date(r.date),
          amount: r.amount,
          direction: r.type,
          counterpartyName: r.counterpartyName,
          description: r.description,
          status: 'NEW' as const,
          suggestedCategoryId:
            applyRules(rules, {
              description: r.description,
              counterpartyName: r.counterpartyName,
              type: r.type,
              amount: r.amount,
              accountId: body.accountId,
              source: 'IMPORT',
            }).categoryId ?? null,
          importBatchId: batch.id,
        })),
      });

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
    return this.prisma.$transaction(
      async (tx) => {
        const batch = await tx.importBatch.findFirst({
          where: { id: batchId, workspaceId, deletedAt: null },
          select: { id: true, filename: true, rowsImported: true },
        });
        if (!batch) throw new NotFoundException('Импорт не найден или уже отменён');

        // Строки этого пакета вместе с тем, во что они успели превратиться.
        const lines = await tx.bankStatementLine.findMany({
          where: { workspaceId, importBatchId: batchId },
          select: {
            id: true,
            adopted: true,
            transferId: true,
            transaction: { select: { id: true, orderId: true } },
          },
        });

        // Строка, ставшая ногой перевода, в одиночку не откатывается: у перевода
        // две стороны, и снос одной оставил бы вторую висеть без пары. Перевод
        // отменяется в своём разделе — там это делается целиком.
        if (lines.some((l) => l.transferId)) {
          throw new ConflictException(
            'Часть строк этого импорта уже сведена в переводы. Сначала отмените переводы, потом импорт.',
          );
        }

        // Затронутые заказы — до soft-delete (после проводки станут deletedAt и
        // из выборки выпадут). Только привязанные оплаты (orderId != null).
        // Учитываем оба поколения пакетов: строки «Входящих» (сейчас) и проводки,
        // привязанные к батчу напрямую (файл раньше создавал операции сразу).
        const linkedTx = await tx.transaction.findMany({
          where: { workspaceId, importBatchId: batchId, deletedAt: null, orderId: { not: null } },
          select: { orderId: true },
          distinct: ['orderId'],
        });
        const orderIds = Array.from(
          new Set(
            [
              ...linkedTx.map((t) => t.orderId),
              ...lines.map((l) => l.transaction?.orderId ?? null),
            ].filter((x): x is string => !!x),
          ),
        ).sort(); // детерминированный порядок локов — анти-deadlock между двумя откатами

        // Лок заказов FOR UPDATE ДО пересчёта — сериализует откат с параллельной
        // addPayment/deletePayment того же заказа (иначе last-writer-wins по paidAmount).
        for (const orderId of orderIds) {
          await this.orders.lockForUpdate(tx, workspaceId, orderId);
        }

        // Проводки, порождённые строками пакета. Усыновлённые (adopted) не трогаем:
        // такая операция существовала ДО импорта и принадлежит человеку — удалить
        // её значило бы стереть чужую запись вместе с категорией (та же развилка,
        // что в inbox.undo).
        const ownTxIds = lines
          .filter((l) => l.transaction && !l.adopted)
          .map((l) => l.transaction!.id);
        const delFromLines = ownTxIds.length
          ? await tx.transaction.updateMany({
              where: { id: { in: ownTxIds }, deletedAt: null },
              data: { deletedAt: new Date() },
            })
          : { count: 0 };

        // Сами строки. У BankStatementLine нет soft-delete: строка — копия записи
        // банка/файла, а не запись пользователя, и её возвращает повторная загрузка.
        const delLines = await tx.bankStatementLine.deleteMany({
          where: { workspaceId, importBatchId: batchId },
        });

        // Наследие: пакеты, залитые до перехода на «Входящие», держат проводки
        // напрямую через importBatchId.
        const delLegacy = await tx.transaction.updateMany({
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

        const reverted = delLines.count + delLegacy.count;
        await this.audit.record(tx, {
          workspaceId,
          actorId: userId,
          action: 'import.revert',
          entityType: 'ImportBatch',
          entityId: batchId,
          diff: {
            filename: batch.filename,
            reverted,
            linesRemoved: delLines.count,
            transactionsRemoved: delFromLines.count + delLegacy.count,
            ordersRecalced: orderIds.length,
          },
        });

        return { reverted, ordersRecalced: orderIds.length };
      },
      // Как UoW.run: откат может лочить несколько заказов — дефолтных 5с мало под нагрузкой.
      { timeout: 15000 },
    );
  }
}
