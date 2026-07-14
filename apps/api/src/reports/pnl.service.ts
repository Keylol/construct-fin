import { Injectable } from '@nestjs/common';
import { Prisma, type CategoryBucket, type TransactionKind } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  enumerateMonths,
  enumerateQuarters,
  type Period,
} from './period';

export type GroupBy = 'month' | 'quarter';

export interface CategoryBreakdown {
  categoryId: string | null;
  categoryName: string | null;
  income: string;
  expense: string;
}

export interface BucketBreakdown {
  bucket: CategoryBucket;
  income: string;
  expense: string;
}

export interface PnlBucket {
  label: string;
  from: string;
  to: string;
  income: string;
  expense: string;
  /// Себестоимость заказов (Transaction.kind=COGS), часть expense.
  cogs: string;
  /// Валовая прибыль = income − cogs.
  grossProfit: string;
  /**
   * Чистая прибыль для P&L: доход − все операционные расходы.
   * Из расхода вычитаются движения по CAPITAL (вложение/изъятие собственника
   * не относится к операционке).
   */
  net: string;
  byCategory: CategoryBreakdown[];
  byBucket: BucketBreakdown[];
}

export interface PnlReport {
  primary: { period: { from: string; to: string }; buckets: PnlBucket[]; totals: PnlBucket };
  comparison: { period: { from: string; to: string }; buckets: PnlBucket[]; totals: PnlBucket } | null;
}

const ALL_BUCKETS: CategoryBucket[] = [
  'REVENUE',
  'COGS',
  'PURCHASES',
  'FIXED',
  'VARIABLE',
  'TAX',
  'CAPITAL',
  'OTHER',
];

interface CategoryMeta {
  id: string;
  name: string;
  bucket: CategoryBucket;
}

@Injectable()
export class PnlService {
  constructor(private readonly prisma: PrismaService) {}

  async build(opts: {
    workspaceId: string;
    primary: Period;
    comparison: Period | null;
    groupBy: GroupBy;
  }): Promise<PnlReport> {
    const categories = await this.prisma.category.findMany({
      where: { workspaceId: opts.workspaceId, deletedAt: null },
      select: { id: true, name: true, bucket: true },
    });
    const catById = new Map(categories.map((c) => [c.id, c as CategoryMeta]));

    const primary = await this.computeSeries(
      opts.workspaceId,
      opts.primary,
      opts.groupBy,
      catById,
    );
    const comparison = opts.comparison
      ? await this.computeSeries(opts.workspaceId, opts.comparison, opts.groupBy, catById)
      : null;
    return { primary, comparison };
  }

  private async computeSeries(
    workspaceId: string,
    period: Period,
    groupBy: GroupBy,
    catById: Map<string, CategoryMeta>,
  ) {
    const slices =
      groupBy === 'month' ? enumerateMonths(period) : enumerateQuarters(period);

    const nameById = new Map<string, string>();
    for (const [id, meta] of catById.entries()) nameById.set(id, meta.name);

    // ОДИН запрос на серию вместо O(слайсов): groupBy по [бакет-периода, type,
    // categoryId, kind] через date_trunc в поясе бизнеса (+5, фикс. сдвиг как в
    // period.ts — без DST). Метка бакета совпадает с enumerateMonths/Quarters
    // (YYYY-MM / YYYY-Q#). Классификация по бакетам остаётся в JS (ниже) —
    // меняется только источник строк. Арифметика: NUMERIC в SQL → Prisma.Decimal.
    const trunc = groupBy === 'month' ? 'month' : 'quarter';
    const labelFmt = groupBy === 'month' ? 'YYYY-MM' : 'YYYY"-Q"Q';
    const rawRows = await this.prisma.$queryRaw<
      Array<{
        label: string;
        type: string;
        categoryId: string | null;
        kind: string;
        sum: Prisma.Decimal | null;
      }>
    >(
      Prisma.sql`
        SELECT to_char(date_trunc(${trunc}, "date" + interval '5 hours'), ${labelFmt}) AS label,
               "type"::text AS type,
               "categoryId" AS "categoryId",
               "kind"::text AS kind,
               SUM("amount") AS sum
        FROM "Transaction"
        WHERE "workspaceId" = ${workspaceId}
          AND "deletedAt" IS NULL
          AND "date" >= ${period.from}
          AND "date" <= ${period.to}
          -- Исключены ПО kind (IJ9 — ОПиУ по реализации, docs/ij9-accrual-design.md):
          --  • TRANSFER_IN/OUT — ноги переводов (не доход/расход);
          --  • ORDER_PAYMENT/ORDER_REFUND — движение денег по заказу (место — ОДДС),
          --    выручка признаётся по closedAt из заказов (recognition ниже);
          --  • COGS — себестоимость берётся из позиций заказов и событий возврата
          --    (единый источник с отчётом маржи); проводки остаются для аудита.
          -- WRITE_OFF (потери) и комиссия перевода (VARIABLE_COST) остаются расходом.
          AND "kind"::text NOT IN ('TRANSFER_IN', 'TRANSFER_OUT', 'ORDER_PAYMENT', 'ORDER_REFUND', 'COGS')
        GROUP BY 1, "type", "categoryId", "kind"
      `,
    );
    const rowsByLabel = new Map<string, typeof rawRows>();
    for (const r of rawRows) {
      const arr = rowsByLabel.get(r.label) ?? [];
      arr.push(r);
      rowsByLabel.set(r.label, arr);
    }

    // IJ9: признание заказов по реализации — DONE-заказы по closedAt (только
    // целиком при закрытии, решение №6). Выручка = totalAmount (кэш
    // subtotal − скидка); себестоимость = Σ qty × (unitCostAtSale ?? unitCost ?? 0)
    // по позициям — формула BR1 как в отчёте маржи, но GROSS: возвраты
    // минусуются отдельными событиями в СВОЙ месяц (решение №3, ниже).
    const recognitionRows = await this.prisma.$queryRaw<
      Array<{ label: string; revenue: Prisma.Decimal | null; cogs: Prisma.Decimal | null }>
    >(
      Prisma.sql`
        SELECT to_char(date_trunc(${trunc}, o."closedAt" + interval '5 hours'), ${labelFmt}) AS label,
               SUM(o."totalAmount") AS revenue,
               SUM(items."cogs" + ret."cost") AS cogs
        FROM "Order" o
        JOIN LATERAL (
          -- Признание на момент закрытия (qty × cost₀) напрямую невосстановимо:
          -- возвраты пересчитывают unitCostAtSale задним числом. Телескоп событий
          -- даёт точную реконструкцию: qty×cost₀ = netQty×cost_текущий + Σ costAmount
          -- событий позиции (каждое событие = дельта признания до/после).
          SELECT COALESCE(SUM((i."qty" - i."returnedQty") * COALESCE(i."unitCostAtSale", i."unitCost", 0)), 0) AS cogs
          FROM "OrderItem" i
          WHERE i."orderId" = o."id" AND i."deletedAt" IS NULL
        ) items ON TRUE
        JOIN LATERAL (
          SELECT COALESCE(SUM(r."costAmount"), 0) AS cost
          FROM "OrderReturn" r
          WHERE r."orderId" = o."id"
        ) ret ON TRUE
        WHERE o."workspaceId" = ${workspaceId}
          AND o."deletedAt" IS NULL
          AND o."status" = 'DONE'
          AND o."closedAt" >= ${period.from}
          AND o."closedAt" <= ${period.to}
        GROUP BY 1
      `,
    );
    const recByLabel = new Map(recognitionRows.map((r) => [r.label, r]));

    // IJ9: события возврата клиента (OrderReturn, волна И1) — минус выручки и
    // COGS в месяц ВОЗВРАТА. Заказы, откаченные reopen/cancel, событий не имеют
    // (reverseFinalization их удаляет); deletedAt-заказы отфильтрованы join'ом.
    const returnRows = await this.prisma.$queryRaw<
      Array<{ label: string; revenue: Prisma.Decimal | null; cogs: Prisma.Decimal | null }>
    >(
      Prisma.sql`
        SELECT to_char(date_trunc(${trunc}, r."date" + interval '5 hours'), ${labelFmt}) AS label,
               SUM(r."revenueAmount") AS revenue,
               SUM(r."costAmount") AS cogs
        FROM "OrderReturn" r
        JOIN "Order" o ON o."id" = r."orderId"
        WHERE r."workspaceId" = ${workspaceId}
          AND o."deletedAt" IS NULL
          AND r."date" >= ${period.from}
          AND r."date" <= ${period.to}
        GROUP BY 1
      `,
    );
    const retByLabel = new Map(returnRows.map((r) => [r.label, r]));

    const buckets: PnlBucket[] = [];
    let totalIncome = new Prisma.Decimal(0);
    let totalExpense = new Prisma.Decimal(0);
    let totalCogs = new Prisma.Decimal(0);
    const totalsByCat = new Map<string | null, { income: Prisma.Decimal; expense: Prisma.Decimal }>();
    const totalsByBucket = newBucketMap();

    for (const slice of slices) {
      // Системные операции без categoryId (WRITE_OFF, ноги капитала и т.п.)
      // бакетятся по самому kind (см. bucketForSystemKind ниже).
      const groups = (rowsByLabel.get(slice.label) ?? []).map((r) => ({
        type: r.type as 'INCOME' | 'EXPENSE',
        categoryId: r.categoryId,
        kind: r.kind as TransactionKind,
        _sum: { amount: r.sum },
      }));

      const catMap = new Map<string | null, { income: Prisma.Decimal; expense: Prisma.Decimal }>();
      const bucketMap = newBucketMap();

      for (const g of groups) {
        const amount = g._sum.amount ?? new Prisma.Decimal(0);
        const key = g.categoryId;
        const entry = catMap.get(key) ?? {
          income: new Prisma.Decimal(0),
          expense: new Prisma.Decimal(0),
        };
        if (g.type === 'INCOME') {
          entry.income = entry.income.plus(amount);
        } else {
          entry.expense = entry.expense.plus(amount);
        }
        catMap.set(key, entry);

        const totalEntry = totalsByCat.get(key) ?? {
          income: new Prisma.Decimal(0),
          expense: new Prisma.Decimal(0),
        };
        if (g.type === 'INCOME') totalEntry.income = totalEntry.income.plus(amount);
        else totalEntry.expense = totalEntry.expense.plus(amount);
        totalsByCat.set(key, totalEntry);

        // По бакету. Приоритет: явная категория пользователя → её bucket.
        // Если категории нет (системные операции: ORDER_PAYMENT, COGS, ноги
        // капитала, комиссия перевода и т.п. заводятся БЕЗ categoryId) —
        // классифицируем по kind. Раньше всё бескатегорийное падало в OTHER:
        // выручка заказов пряталась в «Прочем», а CAPITAL_IN/OUT попадали в
        // операционку и искажали net. Теперь byBucket сходится с headline:
        // byBucket.COGS.expense === cogs.
        const bucket: CategoryBucket = key
          ? catById.get(key)?.bucket ?? bucketForSystemKind(g.kind)
          : bucketForSystemKind(g.kind);
        const bEntry = bucketMap.get(bucket)!;
        const tEntry = totalsByBucket.get(bucket)!;
        if (g.type === 'INCOME') {
          bEntry.income = bEntry.income.plus(amount);
          tEntry.income = tEntry.income.plus(amount);
        } else {
          bEntry.expense = bEntry.expense.plus(amount);
          tEntry.expense = tEntry.expense.plus(amount);
        }
      }

      // IJ9: инъекция признания заказов (closedAt ∈ слайс) и событий возвратов
      // (date ∈ слайс) в бакеты REVENUE/COGS и в бескатегорийную строку
      // byCategory (там раньше жили бескатегорийные ORDER_PAYMENT/COGS-проводки).
      const zero = new Prisma.Decimal(0);
      const rec = recByLabel.get(slice.label);
      const ret = retByLabel.get(slice.label);
      const recRevenue = rec?.revenue ?? zero;
      const recCogs = rec?.cogs ?? zero;
      const retRevenue = ret?.revenue ?? zero;
      const retCogs = ret?.cogs ?? zero;

      const revEntry = bucketMap.get('REVENUE')!;
      revEntry.income = revEntry.income.plus(recRevenue);
      revEntry.expense = revEntry.expense.plus(retRevenue); // контр-выручка возвратов
      const cogsEntry = bucketMap.get('COGS')!;
      // Может уйти в минус, если возвратов в периоде больше признания — это
      // корректно по дизайну (возврат минусует СВОЙ месяц, решение №3).
      cogsEntry.expense = cogsEntry.expense.plus(recCogs).minus(retCogs);

      const tRev = totalsByBucket.get('REVENUE')!;
      tRev.income = tRev.income.plus(recRevenue);
      tRev.expense = tRev.expense.plus(retRevenue);
      const tCogsEntry = totalsByBucket.get('COGS')!;
      tCogsEntry.expense = tCogsEntry.expense.plus(recCogs).minus(retCogs);

      if (!recRevenue.isZero() || !retRevenue.isZero() || !recCogs.isZero() || !retCogs.isZero()) {
        const nullEntry = catMap.get(null) ?? { income: zero, expense: zero };
        nullEntry.income = nullEntry.income.plus(recRevenue);
        nullEntry.expense = nullEntry.expense.plus(retRevenue).plus(recCogs).minus(retCogs);
        catMap.set(null, nullEntry);
        const tNull = totalsByCat.get(null) ?? { income: zero, expense: zero };
        tNull.income = tNull.income.plus(recRevenue);
        tNull.expense = tNull.expense.plus(retRevenue).plus(recCogs).minus(retCogs);
        totalsByCat.set(null, tNull);
      }

      // Себестоимость периода = расходная часть бакета COGS: признание заказов
      // (позиции, BR1) − события возвратов + WRITE_OFF (потери, по дате) +
      // ручные операции категорий бакета COGS.
      const cogs = bucketMap.get('COGS')!.expense;

      // IJ2: grossProfit = чистая выручка − себестоимость (признание минус
      // события возвратов — «прибыли из воздуха» по-прежнему нет).
      const revenueNet = bucketMap.get('REVENUE')!.income.minus(bucketMap.get('REVENUE')!.expense);
      const grossProfit = revenueNet.minus(cogs);

      // IJ9+IJ3: headline Доход/Расход = Σ бакетов БЕЗ CAPITAL (не операционка)
      // и БЕЗ PURCHASES (закупка склада = актив, решение №5 — инфо-строка вне
      // итога; расход признаётся как COGS при продаже и списаниях). WRITE_OFF
      // теперь ВХОДИТ в net (пересмотр F5: при активе-складе потеря запасов —
      // расход периода, «деньги ушли при закупке» больше не расход ОПиУ).
      // Тождество Доход − Расход === net сохраняется.
      let opIncome = new Prisma.Decimal(0);
      let opExpense = new Prisma.Decimal(0);
      for (const b of ALL_BUCKETS) {
        if (b === 'CAPITAL' || b === 'PURCHASES') continue;
        const e = bucketMap.get(b)!;
        opIncome = opIncome.plus(e.income);
        opExpense = opExpense.plus(e.expense);
      }
      const net = opIncome.minus(opExpense);

      totalIncome = totalIncome.plus(opIncome);
      totalExpense = totalExpense.plus(opExpense);
      totalCogs = totalCogs.plus(cogs);

      buckets.push({
        label: slice.label,
        from: slice.from.toISOString(),
        to: slice.to.toISOString(),
        income: opIncome.toFixed(2),
        expense: opExpense.toFixed(2),
        cogs: cogs.toFixed(2),
        grossProfit: grossProfit.toFixed(2),
        net: net.toFixed(2),
        byCategory: buildBreakdown(catMap, nameById),
        byBucket: buildBucketBreakdown(bucketMap),
      });
    }

    // totalIncome/totalExpense уже операционные (Σ opIncome/opExpense — без CAPITAL,
    // без WRITE_OFF). grossProfit по итогам — из нетто-выручки бакета REVENUE.
    const totalRevenueNet = totalsByBucket
      .get('REVENUE')!
      .income.minus(totalsByBucket.get('REVENUE')!.expense);

    return {
      period: { from: period.from.toISOString(), to: period.to.toISOString() },
      buckets,
      totals: {
        label: 'Total',
        from: period.from.toISOString(),
        to: period.to.toISOString(),
        income: totalIncome.toFixed(2),
        expense: totalExpense.toFixed(2),
        cogs: totalCogs.toFixed(2),
        grossProfit: totalRevenueNet.minus(totalCogs).toFixed(2),
        net: totalIncome.minus(totalExpense).toFixed(2),
        byCategory: buildBreakdown(totalsByCat, nameById),
        byBucket: buildBucketBreakdown(totalsByBucket),
      },
    };
  }
}

/**
 * Бакет для системной операции БЕЗ явной категории — по её kind.
 * Используется только когда categoryId отсутствует (явная категория всегда
 * приоритетна). Закупки склада (PURCHASE) и возврат поставщику (SUPPLIER_REFUND)
 * идут в отдельный бакет PURCHASES: cash-basis признаёт расход в момент закупки,
 * а не продажи; PURCHASES НЕ входит в grossProfit (= выручка − COGS), но входит
 * в операционный net как реальное движение денег. SUPPLIER_REFUND (type=INCOME)
 * гасит PURCHASES.expense → byBucket.PURCHASES = чистые закупки. См.
 * docs/audit-2026-06-16.md (Трек A, бакет PURCHASES + A6).
 */
// export — для теста синхронизации с KINDS_FOR_BUCKET (transaction.service).
export function bucketForSystemKind(kind: TransactionKind): CategoryBucket {
  switch (kind) {
    case 'ORDER_PAYMENT':
    case 'ORDER_REFUND': // контр-выручка (type=EXPENSE «минус выручка»)
      return 'REVENUE';
    case 'COGS':
    case 'WRITE_OFF': // потери запасов уменьшают валовую прибыль (F4, решение #10)
      return 'COGS';
    case 'PURCHASE': // закупка товара на склад
    case 'SUPPLIER_REFUND': // возврат от поставщика — контр-закупка (type=INCOME)
      return 'PURCHASES';
    case 'CAPITAL_IN':
    case 'CAPITAL_OUT':
      return 'CAPITAL';
    case 'TAX':
      return 'TAX';
    case 'FIXED_COST':
    case 'SALARY': // зарплата — постоянная операционная статья
      return 'FIXED';
    case 'VARIABLE_COST': // в т.ч. комиссия перевода (заводится без категории)
      return 'VARIABLE';
    default: // NON_OP, TRANSFER_*, OTHER
      return 'OTHER';
  }
}

function newBucketMap(): Map<CategoryBucket, { income: Prisma.Decimal; expense: Prisma.Decimal }> {
  const m = new Map<CategoryBucket, { income: Prisma.Decimal; expense: Prisma.Decimal }>();
  for (const b of ALL_BUCKETS) {
    m.set(b, { income: new Prisma.Decimal(0), expense: new Prisma.Decimal(0) });
  }
  return m;
}

function buildBucketBreakdown(
  map: Map<CategoryBucket, { income: Prisma.Decimal; expense: Prisma.Decimal }>,
): BucketBreakdown[] {
  return ALL_BUCKETS.map((bucket) => {
    const v = map.get(bucket)!;
    return {
      bucket,
      income: v.income.toFixed(2),
      expense: v.expense.toFixed(2),
    };
  });
}

function buildBreakdown(
  catMap: Map<string | null, { income: Prisma.Decimal; expense: Prisma.Decimal }>,
  nameById: Map<string, string>,
): CategoryBreakdown[] {
  const out: CategoryBreakdown[] = [];
  for (const [categoryId, sums] of catMap.entries()) {
    out.push({
      categoryId,
      categoryName: categoryId ? nameById.get(categoryId) ?? null : null,
      income: sums.income.toFixed(2),
      expense: sums.expense.toFixed(2),
    });
  }
  out.sort((a, b) => {
    const aTot = Number(a.income) + Number(a.expense);
    const bTot = Number(b.income) + Number(b.expense);
    return bTot - aTot;
  });
  return out;
}
