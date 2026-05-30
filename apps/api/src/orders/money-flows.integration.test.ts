/**
 * Интеграционные тесты денежных потоков против реальной БД (construct_v6_test).
 * Покрывают то, что раньше не было покрыто: закупка→склад→WAVG,
 * finalize→списание+COGS, cancel→сторно, синхронизация оплаты, атомарность.
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
let tg = 100000n; // уникальный telegramId на каждый тест

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

async function getItem(id: string) {
  return h.prisma.warehouseItem.findUniqueOrThrow({ where: { id } });
}

describe('Закупка → склад → WAVG', () => {
  it('закупка увеличивает остаток, задаёт avgCost и создаёт PURCHASE-транзакцию', async () => {
    const itemId = await seedWarehouseItem(h.prisma, seed.workspaceId);

    await h.purchases.register(seed.workspaceId, seed.userId, {
      accountId: seed.accountId,
      lines: [{ warehouseItemId: itemId, qty: '10', unitPrice: '100' }],
    });

    const item = await getItem(itemId);
    expect(num(item.qty)).toBe(10);
    expect(num(item.avgCost)).toBe(100);

    const tx = await h.prisma.transaction.findFirstOrThrow({
      where: { workspaceId: seed.workspaceId, kind: 'PURCHASE' },
    });
    expect(tx.type).toBe('EXPENSE');
    expect(num(tx.amount)).toBe(1000); // 10 * 100
  });

  it('вторая закупка пересчитывает средневзвешенную себестоимость', async () => {
    const itemId = await seedWarehouseItem(h.prisma, seed.workspaceId);
    await h.purchases.register(seed.workspaceId, seed.userId, {
      accountId: seed.accountId,
      lines: [{ warehouseItemId: itemId, qty: '10', unitPrice: '100' }],
    });
    await h.purchases.register(seed.workspaceId, seed.userId, {
      accountId: seed.accountId,
      lines: [{ warehouseItemId: itemId, qty: '10', unitPrice: '200' }],
    });

    const item = await getItem(itemId);
    expect(num(item.qty)).toBe(20);
    expect(num(item.avgCost)).toBe(150); // (10*100 + 10*200) / 20
  });
});

describe('Finalize складского заказа → списание + unitCostAtSale', () => {
  it('списывает склад по WAVG, фиксирует unitCostAtSale, статус DONE', async () => {
    const itemId = await seedWarehouseItem(h.prisma, seed.workspaceId);
    await h.purchases.register(seed.workspaceId, seed.userId, {
      accountId: seed.accountId,
      lines: [
        { warehouseItemId: itemId, qty: '10', unitPrice: '100' },
        { warehouseItemId: itemId, qty: '10', unitPrice: '200' },
      ],
    });

    const order = await h.orders.create(seed.workspaceId, {
      open: true,
      items: [{ warehouseItemId: itemId, name: 'Деталь A', qty: '5', unitPrice: '500' }],
    });

    const done = await h.orders.finalize(seed.workspaceId, order.id, seed.userId);
    expect(done?.status).toBe('DONE');

    const item = await getItem(itemId);
    expect(num(item.qty)).toBe(15); // 20 - 5

    const oi = await h.prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } });
    expect(num(oi.unitCostAtSale!)).toBe(150); // WAVG на момент продажи
  });
});

describe('Cancel закрытого заказа → сторно', () => {
  it('возвращает товар на склад и очищает unitCostAtSale', async () => {
    const itemId = await seedWarehouseItem(h.prisma, seed.workspaceId);
    await h.purchases.register(seed.workspaceId, seed.userId, {
      accountId: seed.accountId,
      lines: [{ warehouseItemId: itemId, qty: '20', unitPrice: '150' }],
    });
    const order = await h.orders.create(seed.workspaceId, {
      open: true,
      items: [{ warehouseItemId: itemId, name: 'Деталь A', qty: '5', unitPrice: '500' }],
    });
    await h.orders.finalize(seed.workspaceId, order.id, seed.userId);
    expect(num((await getItem(itemId)).qty)).toBe(15);

    const cancelled = await h.orders.cancel(seed.workspaceId, order.id, seed.userId);
    expect(cancelled?.status).toBe('CANCELLED');
    expect(num((await getItem(itemId)).qty)).toBe(20); // вернулось

    const oi = await h.prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } });
    expect(oi.unitCostAtSale).toBeNull();
  });
});

describe('Синхронизация оплаты', () => {
  it('UNPAID → PARTIAL → PAID → OVERPAID по мере оплат', async () => {
    const order = await h.orders.create(seed.workspaceId, {
      open: true,
      items: [{ name: 'Услуга', qty: '1', unitPrice: '1000' }],
    });
    expect(order.paymentStatus).toBe('UNPAID');

    let o = await h.orders.addPayment(seed.workspaceId, order.id, seed.userId, {
      amount: '400',
      accountId: seed.accountId,
    });
    expect(o?.paymentStatus).toBe('PARTIAL');
    expect(num(o!.paidAmount)).toBe(400);

    o = await h.orders.addPayment(seed.workspaceId, order.id, seed.userId, {
      amount: '600',
      accountId: seed.accountId,
    });
    expect(o?.paymentStatus).toBe('PAID');
    expect(num(o!.paidAmount)).toBe(1000);

    o = await h.orders.addPayment(seed.workspaceId, order.id, seed.userId, {
      amount: '50',
      accountId: seed.accountId,
    });
    expect(o?.paymentStatus).toBe('OVERPAID');
    expect(num(o!.paidAmount)).toBe(1050);
  });
});

describe('Ручная себестоимость (позиция без склада)', () => {
  it('finalize создаёт COGS-транзакцию по ручному unitCost', async () => {
    const order = await h.orders.create(seed.workspaceId, {
      open: true,
      items: [{ name: 'Работа со своим материалом', qty: '2', unitPrice: '1000', unitCost: '300' }],
    });
    // нужен платёж, чтобы был счёт для списания себестоимости
    await h.orders.addPayment(seed.workspaceId, order.id, seed.userId, {
      amount: '2000',
      accountId: seed.accountId,
    });

    await h.orders.finalize(seed.workspaceId, order.id, seed.userId);

    const cogs = await h.prisma.transaction.findFirstOrThrow({
      where: { workspaceId: seed.workspaceId, kind: 'COGS', orderId: order.id, deletedAt: null },
    });
    expect(cogs.type).toBe('EXPENSE');
    expect(num(cogs.amount)).toBe(600); // 2 * 300
  });
});

describe('Защита от продажи в минус', () => {
  it('finalize заказа с qty больше остатка падает и НЕ меняет состояние (атомарность)', async () => {
    const itemId = await seedWarehouseItem(h.prisma, seed.workspaceId);
    await h.purchases.register(seed.workspaceId, seed.userId, {
      accountId: seed.accountId,
      lines: [{ warehouseItemId: itemId, qty: '3', unitPrice: '100' }],
    });
    const order = await h.orders.create(seed.workspaceId, {
      open: true,
      items: [{ warehouseItemId: itemId, name: 'Деталь A', qty: '5', unitPrice: '500' }],
    });

    await expect(
      h.orders.finalize(seed.workspaceId, order.id, seed.userId),
    ).rejects.toThrow();

    // Склад не тронут, заказ остался OPEN, COGS не создан — транзакция откатилась.
    expect(num((await getItem(itemId)).qty)).toBe(3);
    const stillOpen = await h.orderRepo.findById(seed.workspaceId, order.id);
    expect(stillOpen?.status).toBe('OPEN');
    const cogsCount = await h.prisma.transaction.count({
      where: { orderId: order.id, kind: 'COGS' },
    });
    expect(cogsCount).toBe(0);
  });

  it('атомарность multi-line: первая позиция не списывается, если вторая в минус', async () => {
    const itemA = await seedWarehouseItem(h.prisma, seed.workspaceId, 'A');
    const itemB = await seedWarehouseItem(h.prisma, seed.workspaceId, 'B');
    await h.purchases.register(seed.workspaceId, seed.userId, {
      accountId: seed.accountId,
      lines: [
        { warehouseItemId: itemA, qty: '10', unitPrice: '100' },
        { warehouseItemId: itemB, qty: '1', unitPrice: '100' },
      ],
    });
    const order = await h.orders.create(seed.workspaceId, {
      open: true,
      items: [
        { warehouseItemId: itemA, name: 'A', qty: '5', unitPrice: '500' },
        { warehouseItemId: itemB, name: 'B', qty: '5', unitPrice: '500' }, // только 1 в наличии
      ],
    });

    await expect(
      h.orders.finalize(seed.workspaceId, order.id, seed.userId),
    ).rejects.toThrow();

    // itemA НЕ должен быть списан — вся операция откатилась.
    expect(num((await getItem(itemA)).qty)).toBe(10);
    expect(num((await getItem(itemB)).qty)).toBe(1);
  });
});
