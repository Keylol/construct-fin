/**
 * Волна 2, PR 2.1 — C2: доменное удаление ошибочной денежной операции заказа.
 * soft-delete проводки под локом B2 + пересчёт paidAmount + аудит. COGS не
 * удаляется этим путём (управляется отменой/переоткрытием заказа).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildHarness, resetDb, seedBase, type Harness, type Seed } from '../test/money-harness';

let h: Harness;
let seed: Seed;
let tg = 2800000n;

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

async function makeOrder(total = '1000.00') {
  return h.orders.create(seed.workspaceId, {
    phone: '+79000000000', items: [{ name: 'Товар', qty: '1', unitPrice: total }],
  });
}

describe('C2: удаление оплаты заказа', () => {
  it('ошибочная оплата удаляется: paidAmount/статус пересчитываются, аудит пишется', async () => {
    const order = await makeOrder('1000.00');
    // Опечатка: 5000 вместо 500.
    await h.orders.addPayment(seed.workspaceId, order.id, seed.userId, {
      amount: '5000.00',
      accountId: seed.accountId,
    });
    const tx = await h.prisma.transaction.findFirstOrThrow({
      where: { orderId: order.id, kind: 'ORDER_PAYMENT', deletedAt: null },
    });
    expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).paymentStatus).toBe(
      'OVERPAID',
    );

    const after = await h.orders.deletePayment(seed.workspaceId, order.id, tx.id, seed.userId);
    expect(after.paidAmount.toFixed(2)).toBe('0.00');
    expect(after.paymentStatus).toBe('UNPAID');
    // Проводка soft-deleted.
    const gone = await h.prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } });
    expect(gone.deletedAt).not.toBeNull();
    // Аудит.
    const audit = await h.prisma.auditLog.findFirst({
      where: { workspaceId: seed.workspaceId, action: 'order.payment-delete' },
    });
    expect(audit!.entityId).toBe(order.id);
  });

  it('из двух оплат удаляется одна — paidAmount = остаток', async () => {
    const order = await makeOrder('1000.00');
    await h.orders.addPayment(seed.workspaceId, order.id, seed.userId, {
      amount: '300.00',
      accountId: seed.accountId,
    });
    await h.orders.addPayment(seed.workspaceId, order.id, seed.userId, {
      amount: '700.00',
      accountId: seed.accountId,
    });
    const wrong = await h.prisma.transaction.findFirstOrThrow({
      where: { orderId: order.id, kind: 'ORDER_PAYMENT', amount: '700', deletedAt: null },
    });
    const after = await h.orders.deletePayment(seed.workspaceId, order.id, wrong.id, seed.userId);
    expect(after.paidAmount.toFixed(2)).toBe('300.00');
    expect(after.paymentStatus).toBe('PARTIAL');
  });

  it('комиссия рассрочки (VARIABLE_COST) удаляема', async () => {
    const order = await makeOrder('100000.00');
    await h.orders.addInstallmentPayment(seed.workspaceId, order.id, seed.userId, {
      amount: '100000.00',
      fee: '5000.00',
      accountId: seed.accountId,
    });
    const fee = await h.prisma.transaction.findFirstOrThrow({
      where: { orderId: order.id, kind: 'VARIABLE_COST', deletedAt: null },
    });
    await expect(
      h.orders.deletePayment(seed.workspaceId, order.id, fee.id, seed.userId),
    ).resolves.toBeTruthy();
    expect(
      (await h.prisma.transaction.findUniqueOrThrow({ where: { id: fee.id } })).deletedAt,
    ).not.toBeNull();
  });

  it('COGS через этот путь удалить нельзя → 400', async () => {
    const order = await h.orders.create(seed.workspaceId, {
      phone: '+79000000000', items: [{ name: 'Услуга', qty: '1', unitPrice: '1000', unitCost: '400' }],
    });
    await h.orders.addPayment(seed.workspaceId, order.id, seed.userId, {
      amount: '1000',
      accountId: seed.accountId,
    });
    await h.orders.finalize(seed.workspaceId, order.id, seed.userId);
    const cogs = await h.prisma.transaction.findFirstOrThrow({
      where: { orderId: order.id, kind: 'COGS', deletedAt: null },
    });
    await expect(
      h.orders.deletePayment(seed.workspaceId, order.id, cogs.id, seed.userId),
    ).rejects.toThrow(/себестоимость|платёж/);
  });

  it('чужая/несуществующая проводка → 404', async () => {
    const order = await makeOrder();
    await expect(
      h.orders.deletePayment(seed.workspaceId, order.id, 'cme00000000000000000000zz', seed.userId),
    ).rejects.toThrow(/не найдена/);
  });

  it('удаление ошибочной оплаты работает и на ОТМЕНЁННОМ заказе (коррекция)', async () => {
    const order = await makeOrder('1000.00');
    await h.orders.addPayment(seed.workspaceId, order.id, seed.userId, {
      amount: '5000.00',
      accountId: seed.accountId,
    });
    const tx = await h.prisma.transaction.findFirstOrThrow({
      where: { orderId: order.id, kind: 'ORDER_PAYMENT', deletedAt: null },
    });
    await h.orders.cancel(seed.workspaceId, order.id, seed.userId);
    // Отмена оставляет платежи; ошибочный удаляем и на CANCELLED.
    const after = await h.orders.deletePayment(seed.workspaceId, order.id, tx.id, seed.userId);
    expect(after.paidAmount.toFixed(2)).toBe('0.00');
    expect(after.status).toBe('CANCELLED');
  });
});
