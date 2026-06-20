import { Injectable } from '@nestjs/common';
import { Prisma, type TransactionKind } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { enumerateMonths, type Period } from './period';
import { NON_CASH_CONSOLIDATED, NON_CASH_FOR_ACCOUNT } from '../common/transaction-kinds';

// Бизнес-пояс UTC+5 фиксированным сдвигом (как в reports/period.ts — БЕЗ DST,
// поэтому именно interval, а не 'Asia/Yekaterinburg' с историческими переходами).
// "date" — timestamp without time zone (UTC-инстант), +5ч даёт стенные часы +5.
const TZ_SHIFT = Prisma.sql`+ interval '5 hours'`;

/** Суммы доход/расход за бакет (или за prior-период). */
interface IncomeExpense {
  income: Prisma.Decimal;
  expense: Prisma.Decimal;
}

function pickSums(
  rows: Array<{ type: string; sum: Prisma.Decimal | null }>,
): IncomeExpense {
  let income = new Prisma.Decimal(0);
  let expense = new Prisma.Decimal(0);
  for (const r of rows) {
    const v = r.sum ?? new Prisma.Decimal(0);
    if (r.type === 'INCOME') income = income.plus(v);
    else if (r.type === 'EXPENSE') expense = expense.plus(v);
  }
  return { income, expense };
}

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

    const opening = new Prisma.Decimal(account.openingBalance);
    // По одному счёту переводы — реальное движение (видны), но неденежный COGS
    // исключаем (R2): он не двигал деньги этого счёта.
    return this.computeSeries(
      period,
      slices,
      { workspaceId, accountId: account.id, excludedKinds: NON_CASH_FOR_ACCOUNT },
      opening,
      account.id,
      account.name,
    );
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
    // Внутренние переводы гасятся + неденежный COGS не двигает деньги (R2).
    // Комиссия перевода (VARIABLE_COST) при этом остаётся реальным оттоком.
    return this.computeSeries(
      period,
      slices,
      { workspaceId, accountId: null, excludedKinds: NON_CASH_CONSOLIDATED },
      opening,
      null,
      'Все счета',
    );
  }

  /**
   * Общий расчёт серии. ДВА запроса вместо O(месяцев): (1) суммы prior-периода
   * (date < period.from) для стартового баланса; (2) ОДИН groupBy по месяцам
   * внутри периода через date_trunc в поясе бизнеса (+5). Бакеты с нулевым
   * оборотом запрос не вернёт — берём из enumerateMonths и заполняем нулями;
   * метки совпадают (YYYY-MM в том же поясе). Арифметика — NUMERIC в SQL +
   * Prisma.Decimal на выходе (точность и half-up как раньше).
   */
  private async computeSeries(
    period: Period,
    slices: { from: Date; to: Date; label: string }[],
    filter: { workspaceId: string; accountId: string | null; excludedKinds: TransactionKind[] },
    opening: Prisma.Decimal,
    accountId: string | null,
    accountName: string | null,
  ): Promise<CashflowSeries> {
    const { workspaceId, excludedKinds } = filter;
    const accountClause = filter.accountId
      ? Prisma.sql`AND "accountId" = ${filter.accountId}`
      : Prisma.empty;
    // kind::text NOT IN (...) — сравнение по тексту избегает каста параметров к enum.
    const kindClause =
      excludedKinds.length > 0
        ? Prisma.sql`AND "kind"::text NOT IN (${Prisma.join(excludedKinds)})`
        : Prisma.empty;

    const priorRows = await this.prisma.$queryRaw<Array<{ type: string; sum: Prisma.Decimal | null }>>(
      Prisma.sql`
        SELECT "type"::text AS type, SUM("amount") AS sum
        FROM "Transaction"
        WHERE "workspaceId" = ${workspaceId}
          AND "deletedAt" IS NULL
          AND "date" < ${period.from}
          ${accountClause}
          ${kindClause}
        GROUP BY "type"
      `,
    );
    const prior = pickSums(priorRows);
    let runningBalance = opening.plus(prior.income).minus(prior.expense);
    const openingForSeries = runningBalance;

    const monthRows = await this.prisma.$queryRaw<
      Array<{ label: string; type: string; sum: Prisma.Decimal | null }>
    >(
      Prisma.sql`
        SELECT to_char(date_trunc('month', "date" ${TZ_SHIFT}), 'YYYY-MM') AS label,
               "type"::text AS type,
               SUM("amount") AS sum
        FROM "Transaction"
        WHERE "workspaceId" = ${workspaceId}
          AND "deletedAt" IS NULL
          AND "date" >= ${period.from}
          AND "date" <= ${period.to}
          ${accountClause}
          ${kindClause}
        GROUP BY 1, "type"
      `,
    );
    const byLabel = new Map<string, IncomeExpense>();
    for (const r of monthRows) {
      const e = byLabel.get(r.label) ?? { income: new Prisma.Decimal(0), expense: new Prisma.Decimal(0) };
      const v = r.sum ?? new Prisma.Decimal(0);
      if (r.type === 'INCOME') e.income = e.income.plus(v);
      else if (r.type === 'EXPENSE') e.expense = e.expense.plus(v);
      byLabel.set(r.label, e);
    }

    const points: CashflowPoint[] = [];
    for (const slice of slices) {
      const e = byLabel.get(slice.label) ?? {
        income: new Prisma.Decimal(0),
        expense: new Prisma.Decimal(0),
      };
      const net = e.income.minus(e.expense);
      runningBalance = runningBalance.plus(net);
      points.push({
        label: slice.label,
        from: slice.from.toISOString(),
        to: slice.to.toISOString(),
        inflow: e.income.toFixed(2),
        outflow: e.expense.toFixed(2),
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
