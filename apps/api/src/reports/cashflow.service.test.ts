import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { CashflowService } from './cashflow.service';

/**
 * Юнит-тесты cashflow (Полоса A, шаг A4): консолидированный режим не задваивает
 * оборот на внутреннем переводе (ноги transferGroupId!=null исключены), режим
 * по счёту показывает движение. Prisma мокается; groupBy эмулирует фильтр.
 */

interface FakeTx {
  type: 'INCOME' | 'EXPENSE';
  accountId: string;
  transferGroupId: string | null;
  amount: string;
  date: Date;
}

function buildService(accounts: { id: string; name: string; openingBalance: string }[], rows: FakeTx[]) {
  const prisma = {
    account: {
      findMany: vi.fn().mockImplementation(({ select }: { select: Record<string, boolean> }) =>
        Promise.resolve(
          accounts.map((a) => {
            const out: Record<string, unknown> = {};
            if (select.id) out.id = a.id;
            if (select.name) out.name = a.name;
            if (select.openingBalance) out.openingBalance = new Prisma.Decimal(a.openingBalance);
            return out;
          }),
        ),
      ),
      findFirst: vi.fn().mockImplementation(({ where }: { where: { id: string } }) => {
        const a = accounts.find((x) => x.id === where.id);
        return Promise.resolve(
          a ? { id: a.id, name: a.name, openingBalance: new Prisma.Decimal(a.openingBalance) } : null,
        );
      }),
    },
    transaction: {
      groupBy: vi.fn().mockImplementation((args: { where: Record<string, unknown> }) => {
        const where = args.where as {
          accountId?: string;
          transferGroupId?: null;
          date?: { lt?: Date; gte?: Date; lte?: Date };
        };
        const filtered = rows.filter((r) => {
          if (where.accountId && r.accountId !== where.accountId) return false;
          // если в where явно transferGroupId=null — исключаем ноги переводов
          if ('transferGroupId' in where && where.transferGroupId === null && r.transferGroupId !== null)
            return false;
          if (where.date?.lt && !(r.date < where.date.lt)) return false;
          if (where.date?.gte && !(r.date >= where.date.gte)) return false;
          if (where.date?.lte && !(r.date <= where.date.lte)) return false;
          return true;
        });
        const sums = new Map<string, Prisma.Decimal>();
        for (const r of filtered) {
          sums.set(r.type, (sums.get(r.type) ?? new Prisma.Decimal(0)).plus(r.amount));
        }
        return Promise.resolve(
          [...sums.entries()].map(([type, amount]) => ({ type, _sum: { amount } })),
        );
      }),
    },
  };
  const service = new CashflowService(prisma as never);
  return { service, prisma };
}

const PERIOD = {
  from: new Date(2026, 5, 5, 12, 0, 0),
  to: new Date(2026, 5, 25, 12, 0, 0),
};
const inPeriod = new Date(2026, 5, 10, 12, 0, 0);

const ACCOUNTS = [
  { id: 'acc-op', name: 'Касса', openingBalance: '1000.00' },
  { id: 'acc-tr', name: 'Эквайринг', openingBalance: '0.00' },
];

// Перевод 500 с acc-op на acc-tr: две ноги с transferGroupId.
const TRANSFER_ROWS: FakeTx[] = [
  { type: 'EXPENSE', accountId: 'acc-op', transferGroupId: 'tr1', amount: '500.00', date: inPeriod },
  { type: 'INCOME', accountId: 'acc-tr', transferGroupId: 'tr1', amount: '500.00', date: inPeriod },
];

describe('CashflowService — консолидированный режим (A4)', () => {
  it('внутренний перевод НЕ создаёт ни притока, ни оттока в консолидации', async () => {
    const { service } = buildService(ACCOUNTS, TRANSFER_ROWS);
    const report = await service.build({
      workspaceId: 'ws1',
      period: PERIOD,
      accountId: null,
      // mode по умолчанию consolidated
    });
    expect(report.series).toHaveLength(1);
    const pt = report.series[0]!.points[0]!;
    expect(pt.inflow).toBe('0.00');
    expect(pt.outflow).toBe('0.00');
    expect(pt.net).toBe('0.00');
    // openingBalance пула = сумма openingBalance счетов
    expect(report.series[0]!.openingBalance).toBe('1000.00');
    expect(pt.balance).toBe('1000.00');
  });

  it('реальный доход учитывается, нога перевода — нет (консолидация)', async () => {
    const rows: FakeTx[] = [
      ...TRANSFER_ROWS,
      { type: 'INCOME', accountId: 'acc-op', transferGroupId: null, amount: '300.00', date: inPeriod },
    ];
    const { service } = buildService(ACCOUNTS, rows);
    const report = await service.build({ workspaceId: 'ws1', period: PERIOD, accountId: null });
    const pt = report.series[0]!.points[0]!;
    expect(pt.inflow).toBe('300.00'); // только реальный доход
    expect(pt.outflow).toBe('0.00');
    expect(pt.balance).toBe('1300.00');
  });

  it('режим по счёту показывает движение перевода (отток с источника)', async () => {
    const { service } = buildService(ACCOUNTS, TRANSFER_ROWS);
    const report = await service.build({
      workspaceId: 'ws1',
      period: PERIOD,
      accountId: 'acc-op',
    });
    expect(report.series).toHaveLength(1);
    expect(report.series[0]!.accountId).toBe('acc-op');
    const pt = report.series[0]!.points[0]!;
    expect(pt.outflow).toBe('500.00'); // нога OUT видна по счёту
    expect(pt.inflow).toBe('0.00');
    expect(pt.balance).toBe('500.00'); // 1000 - 500
  });

  it('byAccount без accountId даёт серию на каждый счёт (легаси), ноги видны', async () => {
    const { service } = buildService(ACCOUNTS, TRANSFER_ROWS);
    const report = await service.build({
      workspaceId: 'ws1',
      period: PERIOD,
      accountId: null,
      mode: 'byAccount',
    });
    expect(report.series).toHaveLength(2);
    const op = report.series.find((s) => s.accountId === 'acc-op')!;
    const tr = report.series.find((s) => s.accountId === 'acc-tr')!;
    expect(op.points[0]!.outflow).toBe('500.00');
    expect(tr.points[0]!.inflow).toBe('500.00');
  });
});
