import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { BreakdownService } from './breakdown.service';

/**
 * Юнит-тест разбивки (Трек A, A2): ноги переводов между своими счетами
 * (TRANSFER_IN/OUT) исключаются по kind и не попадают в строку
 * «Без категории»/«Без контрагента», не раздувают суммы и доли (share).
 */

interface FakeTx {
  categoryId: string | null;
  counterpartyId: string | null;
  type: 'INCOME' | 'EXPENSE';
  kind: string;
  amount: string;
}

function buildService(rows: FakeTx[]) {
  const groupByCalls: Array<Record<string, unknown>> = [];
  const prisma = {
    transaction: {
      groupBy: vi.fn().mockImplementation((args: { by: string[]; where: Record<string, unknown> }) => {
        groupByCalls.push(args.where);
        const notIn = (args.where.kind as { notIn?: string[] } | undefined)?.notIn ?? [];
        const typeFilter = args.where.type as 'INCOME' | 'EXPENSE' | undefined;
        const groupKey = args.by.includes('counterpartyId') ? 'counterpartyId' : 'categoryId';
        const filtered = rows.filter(
          (r) => !notIn.includes(r.kind) && (!typeFilter || r.type === typeFilter),
        );
        const acc = new Map<
          string,
          { id: string | null; type: string; sum: Prisma.Decimal; count: number }
        >();
        for (const r of filtered) {
          const id: string | null = groupKey === 'counterpartyId' ? r.counterpartyId : r.categoryId;
          const key = `${id}|${r.type}`;
          const cur = acc.get(key) ?? { id, type: r.type, sum: new Prisma.Decimal(0), count: 0 };
          cur.sum = cur.sum.plus(r.amount);
          cur.count += 1;
          acc.set(key, cur);
        }
        return Promise.resolve(
          [...acc.values()].map((v) => ({
            [groupKey]: v.id,
            type: v.type,
            _sum: { amount: v.sum },
            _count: { _all: v.count },
          })),
        );
      }),
    },
    category: { findMany: vi.fn().mockResolvedValue([{ id: 'cat-rev', name: 'Выручка' }]) },
    counterparty: { findMany: vi.fn().mockResolvedValue([]) },
  };
  return { service: new BreakdownService(prisma as never), groupByCalls };
}

const PERIOD = { from: new Date(2026, 5, 1), to: new Date(2026, 5, 30) };

describe('BreakdownService — исключение ног переводов (A2)', () => {
  it('where исключает kind notIn TRANSFER_IN/OUT', async () => {
    const { service, groupByCalls } = buildService([]);
    await service.byCategory({ workspaceId: 'ws1', period: PERIOD, type: 'ALL' });
    expect((groupByCalls[0]!.kind as { notIn: string[] }).notIn).toEqual([
      'TRANSFER_IN',
      'TRANSFER_OUT',
    ]);
  });

  it('перевод не создаёт строку «Без категории» и не искажает доли', async () => {
    const rows: FakeTx[] = [
      { categoryId: 'cat-rev', counterpartyId: null, type: 'INCOME', kind: 'ORDER_PAYMENT', amount: '1000.00' },
      // нога перевода без категории — должна быть исключена
      { categoryId: null, counterpartyId: null, type: 'INCOME', kind: 'TRANSFER_IN', amount: '500.00' },
      { categoryId: null, counterpartyId: null, type: 'EXPENSE', kind: 'TRANSFER_OUT', amount: '500.00' },
    ];
    const { service } = buildService(rows);
    const report = await service.byCategory({ workspaceId: 'ws1', period: PERIOD, type: 'INCOME' });
    expect(report.totalIncome).toBe('1000.00');
    // единственная строка — реальная выручка с долей 100%, без «Без категории»
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]!.id).toBe('cat-rev');
    expect(report.rows[0]!.share).toBe(1);
    expect(report.rows.some((r) => r.id === null)).toBe(false);
  });
});
