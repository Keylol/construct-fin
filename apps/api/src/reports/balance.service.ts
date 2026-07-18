import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ReceivablesService } from '../trade-reports/receivables.service';
import { TaxService } from './tax.service';
import { businessYear } from './period';

/**
 * Управленческий баланс «на сейчас» — третий отчёт классической тройки
 * (ОПиУ + ОДДС + баланс). Никаких новых сущностей: собирается из уже
 * существующих контуров.
 *
 *  Активы:
 *   - денежные средства — по активным счетам (openingBalance + Σ движений),
 *     та же формула, что в сверке (reconciliation);
 *   - дебиторская задолженность — ReceivablesService в режиме onlyClosed:
 *     только закрытые заказы (выручка признана по IJ9), чистая выручка −
 *     оплачено, с учётом возвратов DE1;
 *   - запасы — FIFO-стоимость остатков склада (Σ qtyRemaining × unitCost).
 *
 *  Обязательства:
 *   - авансы клиентов — Σ paidAmount по ОТКРЫТЫМ заказам: деньги получены,
 *     но выручка ещё не признана (ОПиУ признаёт по closedAt, IJ9) — до
 *     закрытия это долг «отгрузить или вернуть»;
 *   - налог к уплате — Σ max(начислено − уплачено, 0) по месяцам текущего
 *     бизнес-года (АУСН Д−Р, TaxService).
 *
 *  Капитал = Активы − Обязательства (остаточная оценка; отдельного учёта
 *  вложений/изъятий собственника в балансе MVP нет — см. группу
 *  «Капитал собственника» в ОПиУ).
 */

export interface BalanceAccountRow {
  id: string;
  name: string;
  balance: string;
}

export interface BalanceReport {
  asOf: string;
  assets: {
    cash: { total: string; accounts: BalanceAccountRow[] };
    receivables: string;
    inventory: string;
    total: string;
  };
  liabilities: {
    customerAdvances: string;
    taxDue: string;
    total: string;
  };
  equity: string;
}

const D0 = new Prisma.Decimal(0);

@Injectable()
export class BalanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly receivables: ReceivablesService,
    private readonly tax: TaxService,
  ) {}

  async build(workspaceId: string, asOf: Date = new Date()): Promise<BalanceReport> {
    const [cash, receivables, inventory, advances, taxDue] = await Promise.all([
      this.cashByAccounts(workspaceId),
      this.receivablesTotal(workspaceId, asOf),
      this.inventoryValue(workspaceId),
      this.customerAdvances(workspaceId),
      this.taxOutstanding(workspaceId, asOf),
    ]);

    const assetsTotal = cash.total.plus(receivables).plus(inventory);
    const liabilitiesTotal = advances.plus(taxDue);
    const equity = assetsTotal.minus(liabilitiesTotal);

    return {
      asOf: asOf.toISOString(),
      assets: {
        cash: {
          total: cash.total.toFixed(2),
          accounts: cash.accounts.map((a) => ({
            id: a.id,
            name: a.name,
            balance: a.balance.toFixed(2),
          })),
        },
        receivables: receivables.toFixed(2),
        inventory: inventory.toFixed(2),
        total: assetsTotal.toFixed(2),
      },
      liabilities: {
        customerAdvances: advances.toFixed(2),
        taxDue: taxDue.toFixed(2),
        total: liabilitiesTotal.toFixed(2),
      },
      equity: equity.toFixed(2),
    };
  }

  /** Суммарный остаток денежных средств (для прогноза платёжного календаря). */
  async cashTotal(workspaceId: string): Promise<Prisma.Decimal> {
    const { total } = await this.cashByAccounts(workspaceId);
    return total;
  }

  /** Остатки активных счетов: openingBalance + Σ INCOME − Σ EXPENSE (как в сверке). */
  private async cashByAccounts(workspaceId: string) {
    const accounts = await this.prisma.account.findMany({
      where: { workspaceId, deletedAt: null, isArchived: false },
      select: { id: true, name: true, openingBalance: true },
      orderBy: { name: 'asc' },
    });
    // Один groupBy на все счета вместо N запросов.
    const sums = await this.prisma.transaction.groupBy({
      by: ['accountId', 'type'],
      where: {
        workspaceId,
        deletedAt: null,
        accountId: { in: accounts.map((a) => a.id) },
      },
      _sum: { amount: true },
    });
    const deltaByAccount = new Map<string, Prisma.Decimal>();
    for (const s of sums) {
      if (!s.accountId) continue;
      const amount = new Prisma.Decimal(s._sum.amount ?? 0);
      const signed = s.type === 'INCOME' ? amount : amount.negated();
      deltaByAccount.set(s.accountId, (deltaByAccount.get(s.accountId) ?? D0).plus(signed));
    }
    const rows = accounts.map((a) => ({
      id: a.id,
      name: a.name,
      balance: new Prisma.Decimal(a.openingBalance).plus(deltaByAccount.get(a.id) ?? D0),
    }));
    const total = rows.reduce((acc, r) => acc.plus(r.balance), D0);
    return { total, accounts: rows };
  }

  private async receivablesTotal(workspaceId: string, asOf: Date): Promise<Prisma.Decimal> {
    // onlyClosed: недоплаченные ЗАКРЫТЫЕ заказы. Незакрытые в балансе живут
    // на стороне обязательств (их предоплаты — авансы клиентов).
    const report = await this.receivables.build(workspaceId, asOf, { onlyClosed: true });
    return new Prisma.Decimal(report.totalDue);
  }

  /** FIFO-стоимость остатков (та же формула, что warehouse.stockValue). */
  private async inventoryValue(workspaceId: string): Promise<Prisma.Decimal> {
    const rows = await this.prisma.$queryRaw<Array<{ total: string }>>`
      SELECT COALESCE(SUM(l."qtyRemaining" * l."unitCost"), 0)::text AS total
      FROM "StockLot" l
      JOIN "WarehouseItem" w ON w."id" = l."warehouseItemId"
      WHERE l."workspaceId" = ${workspaceId}
        AND l."qtyRemaining" > 0
        AND l."deletedAt" IS NULL
        AND w."deletedAt" IS NULL
        AND w."isArchived" = false`;
    return new Prisma.Decimal(rows[0]?.total ?? 0);
  }

  /** Полученные предоплаты по незакрытым заказам (деньги есть, выручки ещё нет). */
  private async customerAdvances(workspaceId: string): Promise<Prisma.Decimal> {
    const agg = await this.prisma.order.aggregate({
      where: {
        workspaceId,
        deletedAt: null,
        status: 'OPEN',
        paidAmount: { gt: 0 },
      },
      _sum: { paidAmount: true },
    });
    return new Prisma.Decimal(agg._sum.paidAmount ?? 0);
  }

  /** Неуплаченный начисленный АУСН за текущий бизнес-год: Σ max(due − paid, 0). */
  private async taxOutstanding(workspaceId: string, asOf: Date): Promise<Prisma.Decimal> {
    const year = await this.tax.yearReport(workspaceId, businessYear(asOf));
    return year.months.reduce((acc, m) => {
      const rest = new Prisma.Decimal(m.taxDue).minus(m.taxPaid);
      return rest.greaterThan(0) ? acc.plus(rest) : acc;
    }, D0);
  }
}
