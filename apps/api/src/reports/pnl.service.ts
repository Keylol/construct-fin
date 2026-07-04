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
          -- Ноги переводов между своими счетами (TRANSFER_IN/OUT) — не доход/расход,
          -- исключаем ПО kind. Комиссия перевода (VARIABLE_COST) ОСТАЁТСЯ расходом.
          AND "kind"::text NOT IN ('TRANSFER_IN', 'TRANSFER_OUT')
        GROUP BY 1, "type", "categoryId", "kind"
      `,
    );
    const rowsByLabel = new Map<string, typeof rawRows>();
    for (const r of rawRows) {
      const arr = rowsByLabel.get(r.label) ?? [];
      arr.push(r);
      rowsByLabel.set(r.label, arr);
    }

    const buckets: PnlBucket[] = [];
    let totalIncome = new Prisma.Decimal(0);
    let totalExpense = new Prisma.Decimal(0);
    let totalCogs = new Prisma.Decimal(0);
    const totalsByCat = new Map<string | null, { income: Prisma.Decimal; expense: Prisma.Decimal }>();
    const totalsByBucket = newBucketMap();

    for (const slice of slices) {
      // COGS-операции заводятся системой без categoryId, поэтому бакетятся не по
      // категории, а по самому kind (см. bucketForSystemKind ниже).
      const groups = (rowsByLabel.get(slice.label) ?? []).map((r) => ({
        type: r.type as 'INCOME' | 'EXPENSE',
        categoryId: r.categoryId,
        kind: r.kind as TransactionKind,
        _sum: { amount: r.sum },
      }));

      let income = new Prisma.Decimal(0);
      let expense = new Prisma.Decimal(0);
      let writeOff = new Prisma.Decimal(0); // F5: неденежные потери склада отдельно
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
          income = income.plus(amount);
          entry.income = entry.income.plus(amount);
        } else {
          expense = expense.plus(amount);
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
        // F5: WRITE_OFF — неденежная потеря (деньги ушли при закупке PURCHASE);
        // копим отдельно, чтобы исключить из операционного net, но оставить в
        // grossProfit через бакет COGS.
        if (g.kind === 'WRITE_OFF') writeOff = writeOff.plus(amount);
      }

      // Себестоимость за период — это расходная часть бакета COGS (единый
      // источник истины; cash-basis: COGS по ручным позициям признаётся в
      // момент finalize заказа, складские товары — в момент PURCHASE).
      const cogs = bucketMap.get('COGS')!.expense;

      // IJ2: grossProfit = чистая выручка − себестоимость. REVENUE.net нетит
      // ORDER_PAYMENT против ORDER_REFUND; SUPPLIER_REFUND (бакет PURCHASES) сюда
      // НЕ попадает. Раньше было operatingIncome − cogs → возврат поставщику
      // прибавлялся как выручка, возврат клиенту не вычитался («прибыль из воздуха»).
      const revenueNet = bucketMap.get('REVENUE')!.income.minus(bucketMap.get('REVENUE')!.expense);
      const grossProfit = revenueNet.minus(cogs);

      // IJ3+F5: headline Доход/Расход и net согласованы. Доход/Расход БЕЗ CAPITAL
      // (вложения/изъятия собственника не операционные — «CAPITAL из headline») и
      // БЕЗ неденежного WRITE_OFF (F5: деньги ушли при закупке, потеря видна только
      // в grossProfit). Тогда Доход − Расход === net тождественно.
      const capitalIncome = bucketMap.get('CAPITAL')!.income;
      const capitalExpense = bucketMap.get('CAPITAL')!.expense;
      const opIncome = income.minus(capitalIncome);
      const opExpense = expense.minus(capitalExpense).minus(writeOff);
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
function bucketForSystemKind(kind: TransactionKind): CategoryBucket {
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
