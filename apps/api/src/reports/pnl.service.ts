import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
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

export interface PnlBucket {
  label: string;
  from: string;
  to: string;
  income: string;
  expense: string;
  net: string;
  byCategory: CategoryBreakdown[];
}

export interface PnlReport {
  primary: { period: { from: string; to: string }; buckets: PnlBucket[]; totals: PnlBucket };
  comparison: { period: { from: string; to: string }; buckets: PnlBucket[]; totals: PnlBucket } | null;
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
    const primary = await this.computeSeries(opts.workspaceId, opts.primary, opts.groupBy);
    const comparison = opts.comparison
      ? await this.computeSeries(opts.workspaceId, opts.comparison, opts.groupBy)
      : null;
    return { primary, comparison };
  }

  private async computeSeries(workspaceId: string, period: Period, groupBy: GroupBy) {
    const slices =
      groupBy === 'month' ? enumerateMonths(period) : enumerateQuarters(period);

    const categories = await this.prisma.category.findMany({
      where: { workspaceId, deletedAt: null },
      select: { id: true, name: true },
    });
    const nameById = new Map(categories.map((c) => [c.id, c.name]));

    const buckets: PnlBucket[] = [];
    let totalIncome = new Prisma.Decimal(0);
    let totalExpense = new Prisma.Decimal(0);
    const totalsByCat = new Map<string | null, { income: Prisma.Decimal; expense: Prisma.Decimal }>();

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

      let income = new Prisma.Decimal(0);
      let expense = new Prisma.Decimal(0);
      const catMap = new Map<string | null, { income: Prisma.Decimal; expense: Prisma.Decimal }>();

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
      }

      totalIncome = totalIncome.plus(income);
      totalExpense = totalExpense.plus(expense);

      buckets.push({
        label: slice.label,
        from: slice.from.toISOString(),
        to: slice.to.toISOString(),
        income: income.toFixed(2),
        expense: expense.toFixed(2),
        net: income.minus(expense).toFixed(2),
        byCategory: buildBreakdown(catMap, nameById),
      });
    }

    return {
      period: { from: period.from.toISOString(), to: period.to.toISOString() },
      buckets,
      totals: {
        label: 'Total',
        from: period.from.toISOString(),
        to: period.to.toISOString(),
        income: totalIncome.toFixed(2),
        expense: totalExpense.toFixed(2),
        net: totalIncome.minus(totalExpense).toFixed(2),
        byCategory: buildBreakdown(totalsByCat, nameById),
      },
    };
  }
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
