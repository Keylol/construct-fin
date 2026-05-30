import { Injectable } from '@nestjs/common';
import { Prisma, type CategoryBucket } from '@prisma/client';
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

    const buckets: PnlBucket[] = [];
    let totalIncome = new Prisma.Decimal(0);
    let totalExpense = new Prisma.Decimal(0);
    let totalCogs = new Prisma.Decimal(0);
    let totalCapital = new Prisma.Decimal(0);
    const totalsByCat = new Map<string | null, { income: Prisma.Decimal; expense: Prisma.Decimal }>();
    const totalsByBucket = newBucketMap();

    for (const slice of slices) {
      const groups = await this.prisma.transaction.groupBy({
        by: ['type', 'categoryId'],
        where: {
          workspaceId,
          deletedAt: null,
          date: { gte: slice.from, lte: slice.to },
        },
        _sum: { amount: true },
      });

      // Себестоимость заказов за этот период (часть expense).
      const cogsAgg = await this.prisma.transaction.aggregate({
        where: {
          workspaceId,
          deletedAt: null,
          kind: 'COGS',
          date: { gte: slice.from, lte: slice.to },
        },
        _sum: { amount: true },
      });
      const cogs = cogsAgg._sum.amount ?? new Prisma.Decimal(0);
      totalCogs = totalCogs.plus(cogs);

      let income = new Prisma.Decimal(0);
      let expense = new Prisma.Decimal(0);
      let capital = new Prisma.Decimal(0);
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

        // По бакету.
        const meta = key ? catById.get(key) : null;
        const bucket: CategoryBucket = meta?.bucket ?? 'OTHER';
        const bEntry = bucketMap.get(bucket)!;
        const tEntry = totalsByBucket.get(bucket)!;
        if (g.type === 'INCOME') {
          bEntry.income = bEntry.income.plus(amount);
          tEntry.income = tEntry.income.plus(amount);
        } else {
          bEntry.expense = bEntry.expense.plus(amount);
          tEntry.expense = tEntry.expense.plus(amount);
        }
        if (bucket === 'CAPITAL') capital = capital.plus(amount);
      }

      totalIncome = totalIncome.plus(income);
      totalExpense = totalExpense.plus(expense);
      totalCapital = totalCapital.plus(capital);

      // P&L net: доход − расход без CAPITAL (вложения/изъятия собственника
      // не операционные). CAPITAL income / CAPITAL expense оба вычитаем.
      const capitalIncome = bucketMap.get('CAPITAL')!.income;
      const capitalExpense = bucketMap.get('CAPITAL')!.expense;
      const operatingIncome = income.minus(capitalIncome);
      const operatingExpense = expense.minus(capitalExpense);
      const net = operatingIncome.minus(operatingExpense);

      buckets.push({
        label: slice.label,
        from: slice.from.toISOString(),
        to: slice.to.toISOString(),
        income: income.toFixed(2),
        expense: expense.toFixed(2),
        cogs: cogs.toFixed(2),
        grossProfit: operatingIncome.minus(cogs).toFixed(2),
        net: net.toFixed(2),
        byCategory: buildBreakdown(catMap, nameById),
        byBucket: buildBucketBreakdown(bucketMap),
      });
    }

    const totalCapIncome = totalsByBucket.get('CAPITAL')!.income;
    const totalCapExpense = totalsByBucket.get('CAPITAL')!.expense;
    const totalOpIncome = totalIncome.minus(totalCapIncome);
    const totalOpExpense = totalExpense.minus(totalCapExpense);

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
        grossProfit: totalOpIncome.minus(totalCogs).toFixed(2),
        net: totalOpIncome.minus(totalOpExpense).toFixed(2),
        byCategory: buildBreakdown(totalsByCat, nameById),
        byBucket: buildBucketBreakdown(totalsByBucket),
      },
    };
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
