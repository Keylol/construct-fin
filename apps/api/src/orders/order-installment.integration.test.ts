/**
 * F3 (решение #5): оплата сторонней рассрочкой — gross, против реальной БД.
 *
 * Контракт: ORDER_PAYMENT на ПОЛНУЮ сумму (выручка не занижается, дебиторка
 * закрывается) + VARIABLE_COST на комиссию (стоимость финансирования отдельным
 * расходом); обе проводки ДЕНЕЖНЫЕ — чистое движение по счёту = нетто-зачисление.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { buildHarness, resetDb, seedBase, type Harness, type Seed } from '../test/money-harness';

let h: Harness;
let seed: Seed;
let tg = 2760000n;

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

const PERIOD = {
  from: new Date('2026-01-01T00:00:00.000Z'),
  to: new Date('2026-12-31T23:59:59.999Z'),
};

async function makeOrder(total = '100000.00') {
  return h.orders.create(seed.workspaceId, {
    items: [{ name: 'Кухня', qty: '1', unitPrice: total }],
  });
}

describe('F3: оплата сторонней рассрочкой (gross)', () => {
  it('две проводки: ORDER_PAYMENT полной суммой + VARIABLE_COST комиссия; заказ PAID', async () => {
    const order = await makeOrder();
    const after = await h.orders.addInstallmentPayment(
      seed.workspaceId,
      order.id,
      seed.userId,
      { amount: '100000.00', fee: '5000.00', accountId: seed.accountId },
    );

    // Дебиторка закрыта полной суммой (не нетто!).
    expect(after.paidAmount.toFixed(2)).toBe('100000.00');
    expect(after.paymentStatus).toBe('PAID');

    const txs = await h.prisma.transaction.findMany({
      where: { workspaceId: seed.workspaceId, orderId: order.id, deletedAt: null },
      orderBy: { type: 'asc' }, // EXPENSE, INCOME
    });
    expect(txs).toHaveLength(2);
    const fee = txs.find((t) => t.kind === 'VARIABLE_COST')!;
    const pay = txs.find((t) => t.kind === 'ORDER_PAYMENT')!;
    expect(pay.type).toBe('INCOME');
    expect(pay.amount.toFixed(2)).toBe('100000.00');
    expect(fee.type).toBe('EXPENSE');
    expect(fee.amount.toFixed(2)).toBe('5000.00');
    expect(fee.description).toContain('Комиссия рассрочки');
    expect(fee.counterpartyId).toBe(pay.counterpartyId);
  });

  it('касса: чистое движение по счёту = нетто-зачисление (95 000)', async () => {
    const order = await makeOrder();
    await h.orders.addInstallmentPayment(seed.workspaceId, order.id, seed.userId, {
      amount: '100000.00',
      fee: '5000.00',
      accountId: seed.accountId,
    });
    const cf = await h.cashflow.build({
      workspaceId: seed.workspaceId,
      period: PERIOD,
      accountId: seed.accountId,
    });
    const net = cf.series[0]!.points.reduce(
      (acc, p) => acc.plus(p.inflow).minus(p.outflow),
      new Prisma.Decimal(0),
    );
    expect(net.toFixed(2)).toBe('95000.00');
  });

  it('P&L: выручка полная (REVENUE 100к), комиссия в VARIABLE (5к)', async () => {
    const order = await makeOrder();
    await h.orders.addInstallmentPayment(seed.workspaceId, order.id, seed.userId, {
      amount: '100000.00',
      fee: '5000.00',
      accountId: seed.accountId,
    });
    const pnl = await h.pnl.build({
      workspaceId: seed.workspaceId,
      primary: PERIOD,
      comparison: null,
      groupBy: 'month',
    });
    const buckets = new Map(pnl.primary.totals.byBucket.map((b) => [b.bucket, b]));
    expect(buckets.get('REVENUE')!.income).toBe('100000.00');
    expect(buckets.get('VARIABLE')!.expense).toBe('5000.00');
  });

  it('комиссия ≥ суммы → 400, ничего не создано', async () => {
    const order = await makeOrder('1000.00');
    await expect(
      h.orders.addInstallmentPayment(seed.workspaceId, order.id, seed.userId, {
        amount: '1000.00',
        fee: '1000.00',
        accountId: seed.accountId,
      }),
    ).rejects.toThrow('Комиссия должна быть меньше суммы');
    expect(
      await h.prisma.transaction.count({
        where: { workspaceId: seed.workspaceId, orderId: order.id },
      }),
    ).toBe(0);
  });

  it('fee=0 — вырожденный случай: одна проводка ORDER_PAYMENT', async () => {
    const order = await makeOrder('1000.00');
    await h.orders.addInstallmentPayment(seed.workspaceId, order.id, seed.userId, {
      amount: '1000.00',
      fee: '0',
      accountId: seed.accountId,
    });
    const txs = await h.prisma.transaction.findMany({
      where: { workspaceId: seed.workspaceId, orderId: order.id, deletedAt: null },
    });
    expect(txs).toHaveLength(1);
    expect(txs[0]!.kind).toBe('ORDER_PAYMENT');
  });

  it('CANCELLED-заказ → 400', async () => {
    const order = await makeOrder('1000.00');
    await h.orders.cancel(seed.workspaceId, order.id, seed.userId);
    await expect(
      h.orders.addInstallmentPayment(seed.workspaceId, order.id, seed.userId, {
        amount: '1000.00',
        fee: '50.00',
        accountId: seed.accountId,
      }),
    ).rejects.toThrow('Заказ отменён');
  });
});
