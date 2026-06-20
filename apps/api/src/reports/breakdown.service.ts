import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NON_CASH_CONSOLIDATED } from '../common/transaction-kinds';
import type { Period } from './period';

export type BreakdownType = 'INCOME' | 'EXPENSE' | 'ALL';

export interface BreakdownRow {
  id: string | null;
  name: string;
  income: string;
  expense: string;
  total: string;
  share: number; // 0..1 from total of net (income+expense depending on type)
  count: number;
}

export interface BreakdownReport {
  period: { from: string; to: string };
  type: BreakdownType;
  totalIncome: string;
  totalExpense: string;
  rows: BreakdownRow[];
}

@Injectable()
export class BreakdownService {
  constructor(private readonly prisma: PrismaService) {}

  async byCategory(opts: {
    workspaceId: string;
    period: Period;
    type: BreakdownType;
  }): Promise<BreakdownReport> {
    const groups = await this.prisma.transaction.groupBy({
      by: ['categoryId', 'type'],
      where: this.buildWhere(opts.workspaceId, opts.period, opts.type),
      _sum: { amount: true },
      _count: { _all: true },
    });

    const categories = await this.prisma.category.findMany({
      where: { workspaceId: opts.workspaceId, deletedAt: null },
      select: { id: true, name: true },
    });
    const nameById = new Map(categories.map((c) => [c.id, c.name]));

    return this.assemble(groups, opts, (id) => (id ? nameById.get(id) ?? '—' : 'Без категории'));
  }

  async byCounterparty(opts: {
    workspaceId: string;
    period: Period;
    type: BreakdownType;
  }): Promise<BreakdownReport> {
    const groups = await this.prisma.transaction.groupBy({
      by: ['counterpartyId', 'type'],
      where: this.buildWhere(opts.workspaceId, opts.period, opts.type),
      _sum: { amount: true },
      _count: { _all: true },
    });

    const counterparties = await this.prisma.counterparty.findMany({
      where: { workspaceId: opts.workspaceId, deletedAt: null },
      select: { id: true, name: true },
    });
    const nameById = new Map(counterparties.map((c) => [c.id, c.name]));

    return this.assemble(
      groups.map((g) => ({ ...g, categoryId: g.counterpartyId })),
      opts,
      (id) => (id ? nameById.get(id) ?? '—' : 'Без контрагента'),
    );
  }

  private buildWhere(
    workspaceId: string,
    period: Period,
    type: BreakdownType,
  ): Prisma.TransactionWhereInput {
    return {
      workspaceId,
      deletedAt: null,
      // Разрез — это аналитика ДЕНЕЖНЫХ движений по категории/контрагенту, поэтому
      // исключаем то же, что и консолидированный денежный расчёт (cashflow/summary):
      //  - ноги переводов между своими счетами (TRANSFER_IN/OUT) — не доход/расход
      //    (без фильтра валились в «Без категории» и раздували суммы/доли);
      //  - COGS (неденежный, R2) — иначе расход by-category завышался под «Без
      //    категории» и расходился с P&L/дашбордом.
      kind: { notIn: NON_CASH_CONSOLIDATED },
      date: { gte: period.from, lte: period.to },
      ...(type === 'ALL' ? {} : { type }),
    };
  }

  private assemble(
    groups: Array<{
      categoryId: string | null;
      type: 'INCOME' | 'EXPENSE';
      _sum: { amount: Prisma.Decimal | null };
      _count: { _all: number };
    }>,
    opts: { period: Period; type: BreakdownType },
    resolveName: (id: string | null) => string,
  ): BreakdownReport {
    const byId = new Map<
      string | null,
      { income: Prisma.Decimal; expense: Prisma.Decimal; count: number }
    >();

    for (const g of groups) {
      const entry = byId.get(g.categoryId) ?? {
        income: new Prisma.Decimal(0),
        expense: new Prisma.Decimal(0),
        count: 0,
      };
      const amount = g._sum.amount ?? new Prisma.Decimal(0);
      if (g.type === 'INCOME') entry.income = entry.income.plus(amount);
      else entry.expense = entry.expense.plus(amount);
      entry.count += g._count._all;
      byId.set(g.categoryId, entry);
    }

    let totalIncome = new Prisma.Decimal(0);
    let totalExpense = new Prisma.Decimal(0);
    for (const e of byId.values()) {
      totalIncome = totalIncome.plus(e.income);
      totalExpense = totalExpense.plus(e.expense);
    }

    const denom =
      opts.type === 'INCOME'
        ? totalIncome
        : opts.type === 'EXPENSE'
        ? totalExpense
        : totalIncome.plus(totalExpense);

    const rows: BreakdownRow[] = Array.from(byId.entries()).map(([id, e]) => {
      const total =
        opts.type === 'INCOME'
          ? e.income
          : opts.type === 'EXPENSE'
          ? e.expense
          : e.income.plus(e.expense);
      const share = denom.isZero() ? 0 : Number(total) / Number(denom);
      return {
        id,
        name: resolveName(id),
        income: e.income.toFixed(2),
        expense: e.expense.toFixed(2),
        total: total.toFixed(2),
        share,
        count: e.count,
      };
    });

    rows.sort((a, b) => Number(b.total) - Number(a.total));

    return {
      period: { from: opts.period.from.toISOString(), to: opts.period.to.toISOString() },
      type: opts.type,
      totalIncome: totalIncome.toFixed(2),
      totalExpense: totalExpense.toFixed(2),
      rows,
    };
  }
}
