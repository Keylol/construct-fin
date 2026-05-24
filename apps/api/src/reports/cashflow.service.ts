import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { enumerateMonths, type Period } from './period';

export interface CashflowPoint {
  label: string; // YYYY-MM
  from: string;
  to: string;
  inflow: string;
  outflow: string;
  net: string;
  balance: string; // running balance at end of slice
}

export interface CashflowSeries {
  accountId: string | null;
  accountName: string | null;
  openingBalance: string;
  points: CashflowPoint[];
}

export interface CashflowReport {
  period: { from: string; to: string };
  series: CashflowSeries[];
}

@Injectable()
export class CashflowService {
  constructor(private readonly prisma: PrismaService) {}

  async build(opts: {
    workspaceId: string;
    period: Period;
    accountId: string | null;
  }): Promise<CashflowReport> {
    const accounts = await this.prisma.account.findMany({
      where: {
        workspaceId: opts.workspaceId,
        deletedAt: null,
        ...(opts.accountId ? { id: opts.accountId } : {}),
      },
      select: { id: true, name: true, openingBalance: true },
    });

    const slices = enumerateMonths(opts.period);
    const series: CashflowSeries[] = [];

    for (const account of accounts) {
      const priorGroups = await this.prisma.transaction.groupBy({
        by: ['type'],
        where: {
          workspaceId: opts.workspaceId,
          accountId: account.id,
          deletedAt: null,
          date: { lt: opts.period.from },
        },
        _sum: { amount: true },
      });
      const priorIncome =
        priorGroups.find((g) => g.type === 'INCOME')?._sum.amount ?? new Prisma.Decimal(0);
      const priorExpense =
        priorGroups.find((g) => g.type === 'EXPENSE')?._sum.amount ?? new Prisma.Decimal(0);
      let runningBalance = new Prisma.Decimal(account.openingBalance)
        .plus(priorIncome)
        .minus(priorExpense);
      const openingForSeries = runningBalance;

      const points: CashflowPoint[] = [];
      for (const slice of slices) {
        const groups = await this.prisma.transaction.groupBy({
          by: ['type'],
          where: {
            workspaceId: opts.workspaceId,
            accountId: account.id,
            deletedAt: null,
            date: { gte: slice.from, lte: slice.to },
          },
          _sum: { amount: true },
        });
        const inflow =
          groups.find((g) => g.type === 'INCOME')?._sum.amount ?? new Prisma.Decimal(0);
        const outflow =
          groups.find((g) => g.type === 'EXPENSE')?._sum.amount ?? new Prisma.Decimal(0);
        const net = new Prisma.Decimal(inflow).minus(outflow);
        runningBalance = runningBalance.plus(net);
        points.push({
          label: slice.label,
          from: slice.from.toISOString(),
          to: slice.to.toISOString(),
          inflow: inflow.toFixed(2),
          outflow: outflow.toFixed(2),
          net: net.toFixed(2),
          balance: runningBalance.toFixed(2),
        });
      }

      series.push({
        accountId: account.id,
        accountName: account.name,
        openingBalance: openingForSeries.toFixed(2),
        points,
      });
    }

    return {
      period: { from: opts.period.from.toISOString(), to: opts.period.to.toISOString() },
      series,
    };
  }
}
