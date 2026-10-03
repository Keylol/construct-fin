import { Injectable } from '@nestjs/common';
import { Prisma, type CategoryBucket, type TransactionKind } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { D } from '../common/money';
import { PnlService, TAX_ACCRUAL_NAME, type PnlBucket } from './pnl.service';
import type { Period } from './period';
import {
  compareGroups,
  computeShares,
  groupExpenses,
  monthPeriod,
  shiftMonth,
  type CategoryNode,
  type ExpenseGroup,
} from './month-summary.calc';

/**
 * «Итоги месяца» — ОПиУ одного месяца простыми словами для владельца: сколько
 * продали, сколько ушло на комплектующие, на что ушли расходы и что осталось.
 *
 * Считается ТОЛЬКО поверх ОПиУ (PnlService, налог по начислению, как на
 * экране): чистая прибыль — ровно totals.net, продажи и комплектующие — бакеты
 * REVENUE и COGS, группы расходов — строки операций того же расчёта. Второй
 * формулы прибыли здесь нет, поэтому цифры совпадают с ОПиУ до копейки, а
 * тождество «продажи − комплектующие − расходы + прочие доходы = прибыль»
 * проверяется и отдаётся в checks.identity, а не подгоняется.
 */

export interface MonthSummaryGroup {
  key: string;
  name: string;
  amount: string;
  /** Рублей из каждых 100 ₽ продаж, один знак; null — продаж нет. */
  per100: string | null;
  /** Рублей на один закрытый заказ; null — закрытых заказов нет. */
  perOrder: string | null;
  prevAmount: string;
  /** Статьи группы — переход к операциям месяца. */
  categoryIds: string[];
  /** Виды операций без статьи в группе — переход к операциям месяца. */
  uncategorizedKinds: TransactionKind[];
  /** В группе начисленный налог АУСН: он виден в разделе «Налог», а не в операциях. */
  taxAccrual: boolean;
}

export interface MonthSummaryOrderRef {
  id: string;
  number: string;
  phone: string | null;
  clientName: string | null;
}

export interface MonthSummaryReport {
  month: string;
  from: string;
  to: string;
  /** Заказы, закрытые в месяце (DONE, closedAt в месяце, не удалённые). */
  ordersClosed: number;
  /** Продажи: бакет REVENUE, доходы − расходы (возвраты клиентам). */
  sales: string;
  /** Комплектующие: расход бакета COGS (себестоимость проданного, гарантия, списания). */
  components: string;
  /** Наценка = продажи − комплектующие. */
  markup: string;
  /** Наценка на 100 ₽ продаж (= 100 − комплектующие на 100 ₽), один знак. */
  markupPct: string | null;
  /** Σ групп расходов. */
  expenses: string;
  /** Доходы вне продаж, которые ОПиУ учитывает в прибыли (бакеты COGS/FIXED/VARIABLE/TAX/OTHER). */
  otherIncome: string;
  /** Чистая прибыль — ровно totals.net ОПиУ. */
  net: string;
  netPct: string | null;
  netPerOrder: string | null;
  per100: { components: string; expenses: string; otherIncome: string } | null;
  perOrder: {
    sales: string;
    components: string;
    markup: string;
    expenses: string;
    otherIncome: string;
  } | null;
  groups: MonthSummaryGroup[];
  prev: {
    month: string;
    from: string;
    to: string;
    ordersClosed: number;
    sales: string;
    components: string;
    markup: string;
    expenses: string;
    otherIncome: string;
    net: string;
  };
  /** Сигналы «месяцу пока нельзя доверять». */
  checks: {
    /**
     * Тождество с ОПиУ: diff = (продажи − комплектующие − расходы + прочие
     * доходы) − чистая прибыль. ok — ровно ноль до копейки.
     */
    identity: { ok: boolean; diff: string };
    /** Неразобранные строки выписки (NEW) с датой в месяце. */
    inbox: { count: number; incomeCount: number; income: string; expenseCount: number; expense: string };
    /** Закрытые в месяце заказы с позицией дороже 1 ₽ без закупочной цены. */
    ordersWithoutCost: { count: number; orders: MonthSummaryOrderRef[] };
    /** Открытые заказы с полученной оплатой — на сейчас. */
    openPrepaid: { count: number; paid: string };
  };
}

/** Доходы этих бакетов в прибыли — «прочие доходы» (REVENUE — продажи, CAPITAL и PURCHASES вне прибыли). */
const OTHER_INCOME_BUCKETS: CategoryBucket[] = ['COGS', 'FIXED', 'VARIABLE', 'TAX', 'OTHER'];

interface MonthFigures {
  sales: Prisma.Decimal;
  components: Prisma.Decimal;
  otherIncome: Prisma.Decimal;
  net: Prisma.Decimal;
  groups: ExpenseGroup[];
}

@Injectable()
export class MonthSummaryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pnl: PnlService,
  ) {}

  async build(workspaceId: string, month: string): Promise<MonthSummaryReport> {
    const period = monthPeriod(month);
    const prevMonth = shiftMonth(month, -1);
    const prevPeriod = monthPeriod(prevMonth);

    const categories: CategoryNode[] = await this.prisma.category.findMany({
      where: { workspaceId },
      select: { id: true, name: true, parentId: true, kind: true, deletedAt: true },
    });
    const [cur, prev, ordersClosed, prevOrdersClosed, inbox, ordersWithoutCost, openPrepaid] =
      await Promise.all([
        this.figures(workspaceId, period, categories),
        this.figures(workspaceId, prevPeriod, categories),
        this.countClosed(workspaceId, period),
        this.countClosed(workspaceId, prevPeriod),
        this.inboxCheck(workspaceId, period),
        this.ordersWithoutCost(workspaceId, period),
        this.openPrepaid(workspaceId),
      ]);

    const groups = compareGroups(cur.groups, prev.groups);
    const expenses = sum(groups.map((g) => g.amount));
    const prevExpenses = sum(prev.groups.map((g) => g.amount));
    const diff = cur.sales
      .minus(cur.components)
      .minus(expenses)
      .plus(cur.otherIncome)
      .minus(cur.net);

    const shares = computeShares({
      sales: cur.sales,
      components: cur.components,
      groups: groups.map((g) => g.amount),
      otherIncome: cur.otherIncome,
      net: cur.net,
      ordersClosed,
    });

    return {
      month,
      from: period.from.toISOString(),
      to: period.to.toISOString(),
      ordersClosed,
      sales: cur.sales.toFixed(2),
      components: cur.components.toFixed(2),
      markup: cur.sales.minus(cur.components).toFixed(2),
      markupPct: shares.per100?.markup ?? null,
      expenses: expenses.toFixed(2),
      otherIncome: cur.otherIncome.toFixed(2),
      net: cur.net.toFixed(2),
      netPct: shares.per100?.net ?? null,
      netPerOrder: shares.perOrder?.net ?? null,
      per100: shares.per100
        ? {
            components: shares.per100.components,
            expenses: shares.per100.expenses,
            otherIncome: shares.per100.otherIncome,
          }
        : null,
      perOrder: shares.perOrder
        ? {
            sales: shares.perOrder.sales,
            components: shares.perOrder.components,
            markup: shares.perOrder.markup,
            expenses: shares.perOrder.expenses,
            otherIncome: shares.perOrder.otherIncome,
          }
        : null,
      groups: groups.map((g, i) => ({
        key: g.key,
        name: g.name,
        amount: g.amount.toFixed(2),
        per100: shares.per100?.groups[i] ?? null,
        perOrder: shares.perOrder?.groups[i] ?? null,
        prevAmount: g.prevAmount.toFixed(2),
        categoryIds: g.categoryIds,
        uncategorizedKinds: g.uncategorizedKinds,
        taxAccrual: g.taxAccrual,
      })),
      prev: {
        month: prevMonth,
        from: prevPeriod.from.toISOString(),
        to: prevPeriod.to.toISOString(),
        ordersClosed: prevOrdersClosed,
        sales: prev.sales.toFixed(2),
        components: prev.components.toFixed(2),
        markup: prev.sales.minus(prev.components).toFixed(2),
        expenses: prevExpenses.toFixed(2),
        otherIncome: prev.otherIncome.toFixed(2),
        net: prev.net.toFixed(2),
      },
      checks: {
        identity: { ok: diff.isZero(), diff: diff.toFixed(2) },
        inbox,
        ordersWithoutCost,
        openPrepaid,
      },
    };
  }

  /** Цифры месяца из ОПиУ: тот же вызов, что у экрана ОПиУ, плюс строки операций. */
  private async figures(
    workspaceId: string,
    period: Period,
    categories: CategoryNode[],
  ): Promise<MonthFigures> {
    const report = await this.pnl.build({
      workspaceId,
      primary: period,
      comparison: null,
      groupBy: 'month',
      taxMode: 'accrual',
      withLines: true,
    });
    const totals: PnlBucket = report.primary.totals;
    const bucket = (b: CategoryBucket) => {
      const row = totals.byBucket.find((x) => x.bucket === b);
      return { income: D(row?.income ?? 0), expense: D(row?.expense ?? 0) };
    };
    const revenue = bucket('REVENUE');
    const taxAccrued =
      totals.byCategory.find((c) => c.categoryId === null && c.categoryName === TAX_ACCRUAL_NAME)
        ?.expense ?? '0';
    return {
      sales: revenue.income.minus(revenue.expense),
      components: bucket('COGS').expense,
      otherIncome: sum(OTHER_INCOME_BUCKETS.map((b) => bucket(b).income)),
      net: D(totals.net),
      groups: groupExpenses({ lines: totals.lines ?? [], taxAccrued, categories }),
    };
  }

  /** Заказы, закрытые в периоде, — те же, что признаёт ОПиУ. */
  private countClosed(workspaceId: string, period: Period): Promise<number> {
    return this.prisma.order.count({
      where: {
        workspaceId,
        deletedAt: null,
        status: 'DONE',
        closedAt: { gte: period.from, lte: period.to },
      },
    });
  }

  private async inboxCheck(workspaceId: string, period: Period) {
    const rows = await this.prisma.bankStatementLine.groupBy({
      by: ['direction'],
      where: { workspaceId, status: 'NEW', date: { gte: period.from, lte: period.to } },
      _count: { _all: true },
      _sum: { amount: true },
    });
    const pick = (dir: 'INCOME' | 'EXPENSE') => rows.find((r) => r.direction === dir);
    const inc = pick('INCOME');
    const exp = pick('EXPENSE');
    return {
      count: (inc?._count._all ?? 0) + (exp?._count._all ?? 0),
      incomeCount: inc?._count._all ?? 0,
      income: D(inc?._sum.amount ?? 0).toFixed(2),
      expenseCount: exp?._count._all ?? 0,
      expense: D(exp?._sum.amount ?? 0).toFixed(2),
    };
  }

  /**
   * Закрытые в месяце заказы, у которых есть позиция дороже 1 ₽ с нулевой
   * закупкой: coalesce(unitCostAtSale, unitCost, 0) = 0. Комплектующие по
   * ним не посчитаны, наценка месяца завышена.
   */
  private async ordersWithoutCost(workspaceId: string, period: Period) {
    const orders = await this.prisma.order.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        status: 'DONE',
        closedAt: { gte: period.from, lte: period.to },
        items: {
          some: {
            deletedAt: null,
            unitPrice: { gt: 1 },
            OR: [
              { unitCostAtSale: 0 },
              { unitCostAtSale: null, unitCost: null },
              { unitCostAtSale: null, unitCost: 0 },
            ],
          },
        },
      },
      select: { id: true, number: true, phone: true, client: { select: { name: true } } },
      orderBy: [{ closedAt: 'asc' }, { id: 'asc' }],
    });
    return {
      count: orders.length,
      orders: orders.map((o) => ({
        id: o.id,
        number: o.number,
        phone: o.phone,
        clientName: o.client?.name ?? null,
      })),
    };
  }

  /** Открытые заказы, по которым уже получены деньги: в продажи они войдут при закрытии. */
  private async openPrepaid(workspaceId: string) {
    const agg = await this.prisma.order.aggregate({
      where: { workspaceId, deletedAt: null, status: 'OPEN', paidAmount: { gt: 0 } },
      _count: { _all: true },
      _sum: { paidAmount: true },
    });
    return { count: agg._count._all, paid: D(agg._sum.paidAmount ?? 0).toFixed(2) };
  }
}

function sum(values: Prisma.Decimal[]): Prisma.Decimal {
  return values.reduce((s, v) => s.plus(v), D(0));
}
