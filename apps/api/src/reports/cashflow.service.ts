import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { enumerateMonths, type Period } from './period';
import { NON_CASH_CONSOLIDATED, NON_CASH_FOR_ACCOUNT } from '../common/transaction-kinds';

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

/**
 * Режим расчёта:
 *  - 'byAccount' — по каждому счёту отдельной серией; движения по счетам видны,
 *    включая ноги переводов (перевод виден как отток с одного и приток на другой).
 *  - 'consolidated' — единый пул всех «наших» счетов (любой Account.class); ноги
 *    переводов исключаются ПО kind (TRANSFER_IN/OUT), поэтому перевод между
 *    своими счетами не создаёт ни притока, ни оттока. Комиссия перевода
 *    (kind=VARIABLE_COST, хоть и с transferGroupId) учитывается как отток.
 *
 * Если задан accountId — всегда режим конкретного счёта (byAccount по одному).
 */
export type CashflowMode = 'consolidated' | 'byAccount';

@Injectable()
export class CashflowService {
  constructor(private readonly prisma: PrismaService) {}

  async build(opts: {
    workspaceId: string;
    period: Period;
    accountId: string | null;
    mode?: CashflowMode;
  }): Promise<CashflowReport> {
    const slices = enumerateMonths(opts.period);

    // Конкретный счёт запрошен — всегда по счёту (движения видны).
    if (opts.accountId) {
      const series = await this.bySingleAccount(opts.workspaceId, opts.period, slices, opts.accountId);
      return this.wrap(opts.period, series ? [series] : []);
    }

    const mode: CashflowMode = opts.mode ?? 'consolidated';
    if (mode === 'consolidated') {
      const series = await this.consolidated(opts.workspaceId, opts.period, slices);
      return this.wrap(opts.period, [series]);
    }

    // byAccount без фильтра — серия на каждый счёт (легаси-поведение).
    const accounts = await this.prisma.account.findMany({
      where: { workspaceId: opts.workspaceId, deletedAt: null },
      select: { id: true, name: true, openingBalance: true },
    });
    const series: CashflowSeries[] = [];
    for (const account of accounts) {
      const s = await this.bySingleAccount(
        opts.workspaceId,
        opts.period,
        slices,
        account.id,
        account,
      );
      if (s) series.push(s);
    }
    return this.wrap(opts.period, series);
  }

  private wrap(period: Period, series: CashflowSeries[]): CashflowReport {
    return {
      period: { from: period.from.toISOString(), to: period.to.toISOString() },
      series,
    };
  }

  /** Серия по одному счёту (ноги переводов ВКЛЮЧЕНЫ — движение по счёту видно). */
  private async bySingleAccount(
    workspaceId: string,
    period: Period,
    slices: { from: Date; to: Date; label: string }[],
    accountId: string,
    preloaded?: { id: string; name: string; openingBalance: Prisma.Decimal },
  ): Promise<CashflowSeries | null> {
    const account =
      preloaded ??
      (await this.prisma.account.findFirst({
        where: { id: accountId, workspaceId, deletedAt: null },
        select: { id: true, name: true, openingBalance: true },
      }));
    if (!account) return null;

    const baseWhere: Prisma.TransactionWhereInput = {
      workspaceId,
      accountId,
      deletedAt: null,
      // По одному счёту переводы — реальное движение (видны), но неденежный COGS
      // исключаем (R2): он не двигал деньги этого счёта.
      kind: { notIn: NON_CASH_FOR_ACCOUNT },
    };
    const opening = new Prisma.Decimal(account.openingBalance);
    return this.computeSeries(period, slices, baseWhere, opening, account.id, account.name);
  }

  /**
   * Консолидированная серия по пулу всех счетов. Ноги переводов исключаются
   * ПО kind (TRANSFER_IN/OUT), поэтому внутренние переводы не двигают консолид.
   * оборот; комиссия перевода (kind=VARIABLE_COST, хоть и с transferGroupId)
   * остаётся реальным оттоком. openingBalance пула = сумма openingBalance всех счетов.
   */
  private async consolidated(
    workspaceId: string,
    period: Period,
    slices: { from: Date; to: Date; label: string }[],
  ): Promise<CashflowSeries> {
    const accounts = await this.prisma.account.findMany({
      where: { workspaceId, deletedAt: null },
      select: { openingBalance: true },
    });
    const opening = accounts.reduce(
      (acc, a) => acc.plus(a.openingBalance),
      new Prisma.Decimal(0),
    );
    const baseWhere: Prisma.TransactionWhereInput = {
      workspaceId,
      deletedAt: null,
      // Внутренние переводы гасятся + неденежный COGS не двигает деньги (R2).
      // Комиссия перевода (VARIABLE_COST) при этом остаётся реальным оттоком.
      kind: { notIn: NON_CASH_CONSOLIDATED },
    };
    return this.computeSeries(period, slices, baseWhere, opening, null, 'Все счета');
  }

  /** Общий расчёт серии по заданному where-фильтру и стартовому балансу. */
  private async computeSeries(
    period: Period,
    slices: { from: Date; to: Date; label: string }[],
    baseWhere: Prisma.TransactionWhereInput,
    opening: Prisma.Decimal,
    accountId: string | null,
    accountName: string | null,
  ): Promise<CashflowSeries> {
    const priorGroups = await this.prisma.transaction.groupBy({
      by: ['type'],
      where: { ...baseWhere, date: { lt: period.from } },
      _sum: { amount: true },
    });
    const priorIncome =
      priorGroups.find((g) => g.type === 'INCOME')?._sum.amount ?? new Prisma.Decimal(0);
    const priorExpense =
      priorGroups.find((g) => g.type === 'EXPENSE')?._sum.amount ?? new Prisma.Decimal(0);
    let runningBalance = opening.plus(priorIncome).minus(priorExpense);
    const openingForSeries = runningBalance;

    const points: CashflowPoint[] = [];
    for (const slice of slices) {
      const groups = await this.prisma.transaction.groupBy({
        by: ['type'],
        where: { ...baseWhere, date: { gte: slice.from, lte: slice.to } },
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

    return {
      accountId,
      accountName,
      openingBalance: openingForSeries.toFixed(2),
      points,
    };
  }
}
