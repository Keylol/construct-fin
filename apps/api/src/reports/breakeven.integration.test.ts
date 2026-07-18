/**
 * Интеграционные тесты точки безубыточности: числа сверяются с методологией
 * ОПиУ (IJ9 — выручка/COGS по закрытию заказа, SALARY → постоянные).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildHarness, resetDb, seedBase, type Harness, type Seed } from '../test/money-harness';
import { resolvePeriod } from './period';

let h: Harness;
let seed: Seed;
let tg = 3_300_000n;

beforeAll(() => {
  h = buildHarness();
});
afterAll(async () => {
  await h.prisma.$disconnect();
});
beforeEach(async () => {
  await resetDb(h.prisma);
  tg += 1n;
  seed = await seedBase(h.prisma, tg);
});

const period = () => resolvePeriod({ preset: 'this-month' });

describe('Точка безубыточности', () => {
  it('BEP = постоянные / маржинальность; запас прочности и % прохождения', async () => {
    // Выручка 100 000 и COGS 40 000 — закрытый заказ (признание IJ9).
    await h.prisma.order.create({
      data: {
        workspaceId: seed.workspaceId,
        number: 'B-1',
        status: 'DONE',
        paymentStatus: 'PAID',
        totalAmount: '100000.00',
        paidAmount: '100000.00',
        closedAt: new Date(),
        items: {
          create: [
            {
              name: 'ПК',
              qty: '10',
              unitPrice: '10000.00',
              lineTotal: '100000.00',
              unitCostAtSale: '4000.0000',
            },
          ],
        },
      },
    });
    // Постоянные: аренда 30 000 + зарплата 15 000 (SALARY → FIXED). Переменные 10 000.
    await h.prisma.transaction.createMany({
      data: [
        {
          workspaceId: seed.workspaceId,
          accountId: seed.accountId,
          type: 'EXPENSE',
          kind: 'FIXED_COST',
          amount: '30000.00',
          date: new Date(),
          createdById: seed.userId,
        },
        {
          workspaceId: seed.workspaceId,
          accountId: seed.accountId,
          type: 'EXPENSE',
          kind: 'SALARY',
          amount: '15000.00',
          date: new Date(),
          createdById: seed.userId,
        },
        {
          workspaceId: seed.workspaceId,
          accountId: seed.accountId,
          type: 'EXPENSE',
          kind: 'VARIABLE_COST',
          amount: '10000.00',
          date: new Date(),
          createdById: seed.userId,
        },
      ],
    });

    const r = await h.breakeven.build(seed.workspaceId, period());
    expect(r.revenue).toBe('100000.00');
    expect(r.variableCosts.cogs).toBe('40000.00');
    expect(r.variableCosts.variable).toBe('10000.00');
    expect(r.variableCosts.total).toBe('50000.00');
    expect(r.fixedCosts).toBe('45000.00');
    expect(r.contributionMargin).toBe('50000.00');
    expect(r.contributionMarginPct).toBe(50);
    expect(r.breakevenRevenue).toBe('90000.00');
    expect(r.safetyMarginPct).toBe(10);
    expect(r.achievedPct).toBeCloseTo(111.1, 1);
  });

  it('без выручки точка не определена, постоянные видны', async () => {
    await h.prisma.transaction.create({
      data: {
        workspaceId: seed.workspaceId,
        accountId: seed.accountId,
        type: 'EXPENSE',
        kind: 'FIXED_COST',
        amount: '30000.00',
        date: new Date(),
        createdById: seed.userId,
      },
    });
    const r = await h.breakeven.build(seed.workspaceId, period());
    expect(r.revenue).toBe('0.00');
    expect(r.fixedCosts).toBe('30000.00');
    expect(r.contributionMarginPct).toBeNull();
    expect(r.breakevenRevenue).toBeNull();
    expect(r.safetyMarginPct).toBeNull();
  });

  it('переменные ≥ выручки → BEP недостижим (null), маржинальность ≤ 0', async () => {
    await h.prisma.order.create({
      data: {
        workspaceId: seed.workspaceId,
        number: 'B-2',
        status: 'DONE',
        paymentStatus: 'PAID',
        totalAmount: '50000.00',
        paidAmount: '50000.00',
        closedAt: new Date(),
        items: {
          create: [
            {
              name: 'Убыточный',
              qty: '1',
              unitPrice: '50000.00',
              lineTotal: '50000.00',
              unitCostAtSale: '60000.0000',
            },
          ],
        },
      },
    });
    const r = await h.breakeven.build(seed.workspaceId, period());
    expect(r.revenue).toBe('50000.00');
    expect(r.variableCosts.total).toBe('60000.00');
    expect(r.contributionMarginPct).toBe(-20);
    expect(r.breakevenRevenue).toBeNull();
  });
});
