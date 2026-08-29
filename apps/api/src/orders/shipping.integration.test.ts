/**
 * Интеграционные тесты частичной отгрузки (Полоса A, Волна 2) против реальной БД.
 * Покрывают: ship списывает склад сразу + копит shippedQty (заказ OPEN);
 * finalize отгружает остаток и закрывает; FIFO unitCostAtSale при отгрузках
 * через несколько партий; отмена частично отгруженного OPEN возвращает склад; гварды.
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
let tg = 800000n;

const num = (v: { toString(): string }) => Number(v.toString());
const itemOf = (orderId: string) =>
  h.prisma.orderItem.findFirstOrThrow({ where: { orderId } });
const stockOf = (id: string) =>
  h.prisma.warehouseItem.findUniqueOrThrow({ where: { id } });

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

describe('Частичная отгрузка', () => {
  it('ship списывает склад сразу, копит shippedQty, заказ остаётся OPEN', async () => {
    const itemId = await seedWarehouseItem(h.prisma, seed.workspaceId);
    await h.purchases.register(seed.workspaceId, seed.userId, {
      accountId: seed.accountId,
      lines: [{ warehouseItemId: itemId, qty: '20', unitPrice: '150' }],
    });
    const order = await h.orders.create(seed.workspaceId, {
      phone: '+79000000000', items: [{ warehouseItemId: itemId, name: 'Деталь A', qty: '5', unitPrice: '500' }],
    });
    const oi = await itemOf(order.id);

    const after = await h.orders.ship(seed.workspaceId, order.id, seed.userId, {
      itemId: oi.id,
      qty: '2',
    });

    expect(after?.status).toBe('OPEN'); // не закрылся
    expect(num((await stockOf(itemId)).qty)).toBe(18); // 20 − 2 списано сразу
    const oiAfter = await h.prisma.orderItem.findUniqueOrThrow({ where: { id: oi.id } });
    expect(num(oiAfter.shippedQty)).toBe(2);
    expect(num(oiAfter.unitCostAtSale!)).toBe(150);
    // движение SALE записано
    const sale = await h.prisma.stockMovement.findFirst({
      where: { workspaceId: seed.workspaceId, warehouseItemId: itemId, type: 'SALE' },
    });
    expect(sale).not.toBeNull();
  });

  it('finalize отгружает остаток и закрывает; склад списан на полное qty', async () => {
    const itemId = await seedWarehouseItem(h.prisma, seed.workspaceId);
    await h.purchases.register(seed.workspaceId, seed.userId, {
      accountId: seed.accountId,
      lines: [{ warehouseItemId: itemId, qty: '20', unitPrice: '150' }],
    });
    const order = await h.orders.create(seed.workspaceId, {
      phone: '+79000000000', items: [{ warehouseItemId: itemId, name: 'Деталь A', qty: '5', unitPrice: '500' }],
    });
    const oi = await itemOf(order.id);

    await h.orders.ship(seed.workspaceId, order.id, seed.userId, { itemId: oi.id, qty: '3' });
    const done = await h.orders.finalize(seed.workspaceId, order.id, seed.userId);

    expect(done?.status).toBe('DONE');
    expect(num((await stockOf(itemId)).qty)).toBe(15); // 20 − 5 (3 + остаток 2)
    const oiAfter = await h.prisma.orderItem.findUniqueOrThrow({ where: { id: oi.id } });
    expect(num(oiAfter.shippedQty)).toBe(5);
    expect(num(oiAfter.unitCostAtSale!)).toBe(150);
  });

  it('FIFO unitCostAtSale при отгрузках через несколько партий', async () => {
    const itemId = await seedWarehouseItem(h.prisma, seed.workspaceId);
    // партия №1: 10@100 (qty 10, avg-кэш 100)
    await h.purchases.register(seed.workspaceId, seed.userId, {
      accountId: seed.accountId,
      lines: [{ warehouseItemId: itemId, qty: '10', unitPrice: '100' }],
    });
    const order = await h.orders.create(seed.workspaceId, {
      phone: '+79000000000', items: [{ warehouseItemId: itemId, name: 'Деталь A', qty: '4', unitPrice: '500' }],
    });
    const oi = await itemOf(order.id);

    // отгрузка 2 из партии №1 @100 → у партии №1 остаётся 8, остаток склада 8
    await h.orders.ship(seed.workspaceId, order.id, seed.userId, { itemId: oi.id, qty: '2' });
    // докупка партии №2: 2@300 (получена позже → в хвосте FIFO-очереди), avg-кэш=140
    await h.purchases.register(seed.workspaceId, seed.userId, {
      accountId: seed.accountId,
      lines: [{ warehouseItemId: itemId, qty: '2', unitPrice: '300' }],
    });
    // отгрузка ещё 2: FIFO берёт из партии №1 (в ней ещё 8 @100), НЕ из №2 @300
    await h.orders.ship(seed.workspaceId, order.id, seed.userId, { itemId: oi.id, qty: '2' });

    const oiAfter = await h.prisma.orderItem.findUniqueOrThrow({ where: { id: oi.id } });
    expect(num(oiAfter.shippedQty)).toBe(4);
    // FIFO: обе отгрузки ушли из партии №1 @100 → unitCostAtSale = (100·2 + 100·2)/4 = 100
    expect(num(oiAfter.unitCostAtSale!)).toBe(100);
  });

  it('отмена частично отгруженного OPEN-заказа возвращает склад', async () => {
    const itemId = await seedWarehouseItem(h.prisma, seed.workspaceId);
    await h.purchases.register(seed.workspaceId, seed.userId, {
      accountId: seed.accountId,
      lines: [{ warehouseItemId: itemId, qty: '20', unitPrice: '150' }],
    });
    const order = await h.orders.create(seed.workspaceId, {
      phone: '+79000000000', items: [{ warehouseItemId: itemId, name: 'Деталь A', qty: '5', unitPrice: '500' }],
    });
    const oi = await itemOf(order.id);
    await h.orders.ship(seed.workspaceId, order.id, seed.userId, { itemId: oi.id, qty: '3' });
    expect(num((await stockOf(itemId)).qty)).toBe(17);

    const cancelled = await h.orders.cancel(seed.workspaceId, order.id, seed.userId);
    expect(cancelled?.status).toBe('CANCELLED');
    expect(num((await stockOf(itemId)).qty)).toBe(20); // отгруженные 3 вернулись
    const oiAfter = await h.prisma.orderItem.findUniqueOrThrow({ where: { id: oi.id } });
    expect(num(oiAfter.shippedQty)).toBe(0);
    expect(oiAfter.unitCostAtSale).toBeNull();
  });

  it('remove частично отгруженного OPEN-заказа возвращает склад', async () => {
    const itemId = await seedWarehouseItem(h.prisma, seed.workspaceId);
    await h.purchases.register(seed.workspaceId, seed.userId, {
      accountId: seed.accountId,
      lines: [{ warehouseItemId: itemId, qty: '20', unitPrice: '150' }],
    });
    const order = await h.orders.create(seed.workspaceId, {
      phone: '+79000000000', items: [{ warehouseItemId: itemId, name: 'Деталь A', qty: '5', unitPrice: '500' }],
    });
    const oi = await itemOf(order.id);
    await h.orders.ship(seed.workspaceId, order.id, seed.userId, { itemId: oi.id, qty: '3' });

    await h.orders.remove(seed.workspaceId, order.id, seed.userId);
    expect(num((await stockOf(itemId)).qty)).toBe(20); // 3 отгруженных вернулись
  });

  it('DONE + возврат(RMA) + cancel: склад НЕ задваивается (netOut вычитает returnedQty)', async () => {
    const itemId = await seedWarehouseItem(h.prisma, seed.workspaceId);
    await h.purchases.register(seed.workspaceId, seed.userId, {
      accountId: seed.accountId,
      lines: [{ warehouseItemId: itemId, qty: '20', unitPrice: '150' }],
    });
    const order = await h.orders.create(seed.workspaceId, {
      phone: '+79000000000', items: [{ warehouseItemId: itemId, name: 'Деталь A', qty: '5', unitPrice: '500' }],
    });
    const oi = await itemOf(order.id);
    await h.orders.finalize(seed.workspaceId, order.id, seed.userId); // склад 15, shippedQty 5
    await h.orders.returnItem(seed.workspaceId, order.id, seed.userId, {
      itemId: oi.id,
      returnQty: '2',
      refundAmount: '0',
      accountId: seed.accountId,
    }); // склад 17, returnedQty 2

    await h.orders.cancel(seed.workspaceId, order.id, seed.userId);
    // netOut = qty(5) − returnedQty(2) = 3 → склад 17 + 3 = 20 (а не 22)
    expect(num((await stockOf(itemId)).qty)).toBe(20);
  });

  it('гварды: нельзя отгрузить больше остатка и нельзя отгружать по DONE; нельзя менять позиции', async () => {
    const itemId = await seedWarehouseItem(h.prisma, seed.workspaceId);
    await h.purchases.register(seed.workspaceId, seed.userId, {
      accountId: seed.accountId,
      lines: [{ warehouseItemId: itemId, qty: '20', unitPrice: '150' }],
    });
    const order = await h.orders.create(seed.workspaceId, {
      phone: '+79000000000', items: [{ warehouseItemId: itemId, name: 'Деталь A', qty: '5', unitPrice: '500' }],
    });
    const oi = await itemOf(order.id);

    await h.orders.ship(seed.workspaceId, order.id, seed.userId, { itemId: oi.id, qty: '2' });
    // больше остатка (доступно 3)
    await expect(
      h.orders.ship(seed.workspaceId, order.id, seed.userId, { itemId: oi.id, qty: '4' }),
    ).rejects.toThrow();
    // нельзя менять позиции частично отгруженного
    await expect(
      h.orders.update(seed.workspaceId, order.id, {
        items: [{ warehouseItemId: itemId, name: 'Деталь A', qty: '10', unitPrice: '500' }],
      }),
    ).rejects.toThrow();

    // по DONE отгружать нельзя
    await h.orders.finalize(seed.workspaceId, order.id, seed.userId);
    await expect(
      h.orders.ship(seed.workspaceId, order.id, seed.userId, { itemId: oi.id, qty: '1' }),
    ).rejects.toThrow();
  });
});
