import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { PnlService } from './pnl.service';

/**
 * Юнит-тесты P&L (Полоса A, шаг A3): ноги переводов (TRANSFER_IN/OUT, общий
 * transferGroupId) НЕ участвуют в доходах/расходах; комиссия перевода
 * (VARIABLE_COST, transferGroupId=null) ОСТАЁТСЯ расходом.
 */

interface FakeTx {
  type: 'INCOME' | 'EXPENSE';
  kind: string;
  categoryId: string | null;
  transferGroupId: string | null;
  amount: string;
}

function buildService(rows: FakeTx[]) {
  const groupByCalls: Array<Record<string, unknown>> = [];
  const prisma = {
    category: {
      findMany: vi.fn().mockResolvedValue([
        { id: 'cat-rev', name: 'Выручка', bucket: 'REVENUE' },
        { id: 'cat-var', name: 'Комиссии', bucket: 'VARIABLE' },
      ]),
    },
    transaction: {
      groupBy: vi.fn().mockImplementation((args: { where: Record<string, unknown> }) => {
        groupByCalls.push(args.where);
        // эмулируем фильтр Prisma: transferGroupId=null И kind notIn [...]
        const where = args.where as {
          transferGroupId: null;
          kind?: { notIn: string[] };
        };
        const notIn = where.kind?.notIn ?? [];
        const filtered = rows.filter(
          (r) => r.transferGroupId === null && !notIn.includes(r.kind),
        );
        // groupBy by [type, categoryId, kind]
        const acc = new Map<string, { type: string; categoryId: string | null; kind: string; sum: Prisma.Decimal }>();
        for (const r of filtered) {
          const key = `${r.type}|${r.categoryId}|${r.kind}`;
          const cur = acc.get(key) ?? {
            type: r.type,
            categoryId: r.categoryId,
            kind: r.kind,
            sum: new Prisma.Decimal(0),
          };
          cur.sum = cur.sum.plus(r.amount);
          acc.set(key, cur);
        }
        return Promise.resolve(
          [...acc.values()].map((v) => ({
            type: v.type,
            categoryId: v.categoryId,
            kind: v.kind,
            _sum: { amount: v.sum },
          })),
        );
      }),
    },
  };
  const service = new PnlService(prisma as never);
  return { service, prisma, groupByCalls };
}

// Середина месяца в локальном времени, чтобы enumerateMonths (использует
// getMonth() в локальной TZ) дал ровно один слайс независимо от часового пояса.
const PERIOD = {
  from: new Date(2026, 5, 5, 12, 0, 0),
  to: new Date(2026, 5, 25, 12, 0, 0),
};

describe('PnlService — исключение ног переводов (A3)', () => {
  it('where фильтрует transferGroupId=null и kind notIn TRANSFER_IN/OUT', async () => {
    const { service, groupByCalls } = buildService([]);
    await service.build({ workspaceId: 'ws1', primary: PERIOD, comparison: null, groupBy: 'month' });
    expect(groupByCalls.length).toBeGreaterThan(0);
    for (const where of groupByCalls) {
      expect(where.transferGroupId).toBeNull();
      expect((where.kind as { notIn: string[] }).notIn).toEqual(['TRANSFER_IN', 'TRANSFER_OUT']);
    }
  });

  it('ноги перевода НЕ двигают P&L, а комиссия — двигает', async () => {
    const rows: FakeTx[] = [
      // реальная выручка
      { type: 'INCOME', kind: 'OTHER', categoryId: 'cat-rev', transferGroupId: null, amount: '1000.00' },
      // ноги перевода — должны быть исключены
      { type: 'EXPENSE', kind: 'TRANSFER_OUT', categoryId: null, transferGroupId: 'tr1', amount: '500.00' },
      { type: 'INCOME', kind: 'TRANSFER_IN', categoryId: null, transferGroupId: 'tr1', amount: '500.00' },
      // комиссия перевода — реальный расход, остаётся
      { type: 'EXPENSE', kind: 'VARIABLE_COST', categoryId: 'cat-var', transferGroupId: null, amount: '15.00' },
    ];
    const { service } = buildService(rows);
    const report = await service.build({
      workspaceId: 'ws1',
      primary: PERIOD,
      comparison: null,
      groupBy: 'month',
    });
    const totals = report.primary.totals;
    expect(totals.income).toBe('1000.00'); // TRANSFER_IN не вошёл
    expect(totals.expense).toBe('15.00'); // только комиссия, без TRANSFER_OUT
    expect(totals.net).toBe('985.00'); // 1000 - 15
  });

  it('перевод без прочих операций даёт нулевой P&L', async () => {
    const rows: FakeTx[] = [
      { type: 'EXPENSE', kind: 'TRANSFER_OUT', categoryId: null, transferGroupId: 'tr1', amount: '500.00' },
      { type: 'INCOME', kind: 'TRANSFER_IN', categoryId: null, transferGroupId: 'tr1', amount: '500.00' },
    ];
    const { service } = buildService(rows);
    const report = await service.build({
      workspaceId: 'ws1',
      primary: PERIOD,
      comparison: null,
      groupBy: 'month',
    });
    expect(report.primary.totals.income).toBe('0.00');
    expect(report.primary.totals.expense).toBe('0.00');
    expect(report.primary.totals.net).toBe('0.00');
  });
});
