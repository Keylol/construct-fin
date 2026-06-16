/**
 * Интеграционные тесты возврата клиента (RMA, Полоса E) против реальной БД.
 * Покрывают: restock складской позиции + StockMovement(RETURN_CUSTOMER),
 * накопление OrderItem.returnedQty, Transaction(ORDER_REFUND) + пересчёт
 * paymentStatus, возврат без денег, гварды (не больше проданного, только DONE).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  buildHarness,
  resetDb,
  seedBase,
  seedWarehouseItem,
  type Harness,
  type Seed,
} from '../test/money-harness';

let h: Harness;
let seed: Seed;
let tg = 700000n;

const num = (v: { toString(): string }) => Number(v.toString());

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

/** Хелпер: закупка склада, заказ, оплата, finalize. Возвращает order + itemId. */
async function doneWarehouseOrder(qtySold: string, unitPrice: string) {
  const itemId = await seedWarehouseItem(h.prisma, seed.workspaceId);
  await h.purchases.register(seed.workspaceId, seed.userId, {
    accountId: seed.accountId,
    lines: [{ warehouseItemId: itemId, qty: '20', unitPrice: '150' }],
  });
  const order = await h.orders.create(seed.workspaceId, {
    items: [{ warehouseItemId: itemId, name: 'Деталь A', qty: qtySold, unitPrice }],
  });
  await h.orders.addPayment(seed.workspaceId, order.id, seed.userId, {
    amount: String(Number(qtySold) * Number(unitPrice)),
    accountId: seed.accountId,
  });
  const done = await h.orders.finalize(seed.workspaceId, order.id, seed.userId);
  return { order: done!, itemId };
}

describe('RMA: частичный возврат складской позиции', () => {
  it('restock + returnedQty + ORDER_REFUND + пересчёт оплаты', async () => {
    const { order, itemId } = await doneWarehouseOrder('5', '500'); // продано 5, оплачено 2500
    expect(num((await h.prisma.warehouseItem.findUniqueOrThrow({ where: { id: itemId } })).qty)).toBe(15);

    const oi = await h.prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } });
    const updated = await h.orders.returnItem(seed.workspaceId, order.id, seed.userId, {
      itemId: oi.id,
      returnQty: '2',
      refundAmount: '1000',
      accountId: seed.accountId,
    });

    // склад вернулся: 15 + 2 = 17
    expect(num((await h.prisma.warehouseItem.findUniqueOrThrow({ where: { id: itemId } })).qty)).toBe(17);
    // returnedQty накоплен
    const oiAfter = await h.prisma.orderItem.findUniqueOrThrow({ where: { id: oi.id } });
    expect(num(oiAfter.returnedQty)).toBe(2);
    // движение RETURN_CUSTOMER записано
    const mv = await h.prisma.stockMovement.findFirst({
      where: { workspaceId: seed.workspaceId, warehouseItemId: itemId, type: 'RETURN_CUSTOMER' },
    });
    expect(mv).not.toBeNull();
    expect(num(mv!.qtyDelta)).toBe(2);
    // ORDER_REFUND создан, оплата пересчитана: 2500 - 1000 = 1500 → PARTIAL
    const refund = await h.prisma.transaction.findFirstOrThrow({
      where: { workspaceId: seed.workspaceId, orderId: order.id, kind: 'ORDER_REFUND' },
    });
    expect(refund.type).toBe('EXPENSE');
    expect(num(refund.amount)).toBe(1000);
    expect(num(updated!.paidAmount)).toBe(1500);
    expect(updated!.paymentStatus).toBe('PARTIAL');
  });

  it('возврат без денег (refundAmount=0): склад+returnedQty, без ORDER_REFUND', async () => {
    const { order, itemId } = await doneWarehouseOrder('5', '500');
    const oi = await h.prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } });

    const updated = await h.orders.returnItem(seed.workspaceId, order.id, seed.userId, {
      itemId: oi.id,
      returnQty: '1',
      refundAmount: '0',
      accountId: seed.accountId,
    });

    expect(num((await h.prisma.warehouseItem.findUniqueOrThrow({ where: { id: itemId } })).qty)).toBe(16);
    expect(num((await h.prisma.orderItem.findUniqueOrThrow({ where: { id: oi.id } })).returnedQty)).toBe(1);
    const refundCount = await h.prisma.transaction.count({
      where: { workspaceId: seed.workspaceId, orderId: order.id, kind: 'ORDER_REFUND' },
    });
    expect(refundCount).toBe(0);
    // оплата не изменилась (полная)
    expect(updated!.paymentStatus).toBe('PAID');
  });

  it('накопительные частичные возвраты; нельзя вернуть больше проданного', async () => {
    const { order, itemId } = await doneWarehouseOrder('5', '100');
    const oi = await h.prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } });

    await h.orders.returnItem(seed.workspaceId, order.id, seed.userId, {
      itemId: oi.id,
      returnQty: '2',
      refundAmount: '0',
      accountId: seed.accountId,
    });
    await h.orders.returnItem(seed.workspaceId, order.id, seed.userId, {
      itemId: oi.id,
      returnQty: '2',
      refundAmount: '0',
      accountId: seed.accountId,
    });
    expect(num((await h.prisma.orderItem.findUniqueOrThrow({ where: { id: oi.id } })).returnedQty)).toBe(4);

    // доступно 1, просим 2 → ошибка, состояние не меняется
    await expect(
      h.orders.returnItem(seed.workspaceId, order.id, seed.userId, {
        itemId: oi.id,
        returnQty: '2',
        refundAmount: '0',
        accountId: seed.accountId,
      }),
    ).rejects.toThrow();
    expect(num((await h.prisma.orderItem.findUniqueOrThrow({ where: { id: oi.id } })).returnedQty)).toBe(4);
    // склад: продано 5 (15), вернули 4 → 19
    expect(num((await h.prisma.warehouseItem.findUniqueOrThrow({ where: { id: itemId } })).qty)).toBe(19);
  });

  it('нельзя вернуть по не закрытому (OPEN) заказу', async () => {
    const order = await h.orders.create(seed.workspaceId, {
      items: [{ name: 'Услуга', qty: '1', unitPrice: '1000' }],
    });
    const oi = await h.prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } });
    await expect(
      h.orders.returnItem(seed.workspaceId, order.id, seed.userId, {
        itemId: oi.id,
        returnQty: '1',
        refundAmount: '0',
        accountId: seed.accountId,
      }),
    ).rejects.toThrow();
  });

  it('возврат услуги (без склада): только ORDER_REFUND + returnedQty, без StockMovement', async () => {
    const order = await h.orders.create(seed.workspaceId, {
      items: [{ name: 'Услуга', qty: '2', unitPrice: '1000' }],
    });
    await h.orders.addPayment(seed.workspaceId, order.id, seed.userId, {
      amount: '2000',
      accountId: seed.accountId,
    });
    await h.orders.finalize(seed.workspaceId, order.id, seed.userId);
    const oi = await h.prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } });

    const updated = await h.orders.returnItem(seed.workspaceId, order.id, seed.userId, {
      itemId: oi.id,
      returnQty: '1',
      refundAmount: '1000',
      accountId: seed.accountId,
    });

    // склада нет → ни одного движения по заказу
    const mvCount = await h.prisma.stockMovement.count({
      where: { workspaceId: seed.workspaceId, refType: 'Order', refId: order.id },
    });
    expect(mvCount).toBe(0);
    expect(num((await h.prisma.orderItem.findUniqueOrThrow({ where: { id: oi.id } })).returnedQty)).toBe(1);
    const refund = await h.prisma.transaction.findFirstOrThrow({
      where: { workspaceId: seed.workspaceId, orderId: order.id, kind: 'ORDER_REFUND' },
    });
    expect(num(refund.amount)).toBe(1000);
    expect(num(updated!.paidAmount)).toBe(1000); // 2000 - 1000
    expect(updated!.paymentStatus).toBe('PARTIAL');
  });

  it('гварды: returnQty=0 и отрицательный refund отклоняются', async () => {
    const { order } = await doneWarehouseOrder('3', '100');
    const oi = await h.prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } });

    await expect(
      h.orders.returnItem(seed.workspaceId, order.id, seed.userId, {
        itemId: oi.id,
        returnQty: '0',
        refundAmount: '0',
        accountId: seed.accountId,
      }),
    ).rejects.toThrow();

    await expect(
      h.orders.returnItem(seed.workspaceId, order.id, seed.userId, {
        itemId: oi.id,
        returnQty: '1',
        refundAmount: '-100',
        accountId: seed.accountId,
      }),
    ).rejects.toThrow();

    // состояние не изменилось
    expect(num((await h.prisma.orderItem.findUniqueOrThrow({ where: { id: oi.id } })).returnedQty)).toBe(0);
  });
});

describe('RMA: сторно себестоимости услуги (Блок C · CR1/CR2)', () => {
  it('возврат части услуги создаёт отрицательный COGS и уменьшает себестоимость в P&L', async () => {
    // Услуга 2 шт по 500, ручная себестоимость 300/шт → COGS при finalize = 600.
    const order = await h.orders.create(seed.workspaceId, {
      items: [{ name: 'Монтаж', qty: '2', unitPrice: '500', unitCost: '300' }],
    });
    await h.orders.addPayment(seed.workspaceId, order.id, seed.userId, {
      amount: '1000',
      accountId: seed.accountId,
    });
    await h.orders.finalize(seed.workspaceId, order.id, seed.userId);

    const itemId = (await h.prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } })).id;
    // Вернуть 1 из 2 БЕЗ рефанда (CR2: всё равно сторнируем себестоимость).
    await h.orders.returnItem(seed.workspaceId, order.id, seed.userId, {
      itemId,
      returnQty: '1',
      refundAmount: '0',
      accountId: seed.accountId,
    });

    const cogs = await h.prisma.transaction.findMany({
      where: { orderId: order.id, kind: 'COGS', deletedAt: null },
    });
    // Оригинал +600 и сторно −300 → нетто себестоимость = 300.
    expect(cogs).toHaveLength(2);
    expect(cogs.reduce((s, t) => s + num(t.amount), 0)).toBe(300);
    // Сторно (отрицательный COGS) привязан к оригиналу.
    const reversal = cogs.find((t) => num(t.amount) < 0)!;
    expect(reversal.originalTxId).not.toBeNull();
  });
});
