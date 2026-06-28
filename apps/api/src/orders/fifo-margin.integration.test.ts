/**
 * Канонический кейс корректности маржи на ЧАСТИЧНОМ возврате (F0/FIFO).
 * Реальная БД construct_v6_test — НЕ запускать локально мимоходом (общая БД :5433).
 *
 * Доказывает главное свойство FIFO-перехода: margin == FIFO-COGS ОСТАВШИХСЯ
 * проданных единиц (I8). unitCostAtSale — чистая деривация из net-леджера
 * LotConsumption по orderItemId, поэтому адресный (LIFO) реверс корректно
 * пересчитывает себестоимость на остаток без дрейфа.
 *
 * Стенд: одна позиция, две партии — A: 5@100 (раньше), B: 5@200 (позже).
 * Все числа выведены из первых принципов (расчёт в комментариях).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { buildHarness, resetDb, seedBase, type Harness, type Seed } from '../test/money-harness';

let h: Harness;
let seed: Seed;
let tg = 930000n;

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

interface Stand {
  warehouseItemId: string;
  orderId: string;
  orderItemId: string;
}

/**
 * Партии A (5@100, раньше) и B (5@200, позже) одной позиции; заказ на 10 ед @ 300;
 * finalize → FIFO списывает 5@100 + 5@200. Возвращает id для дальнейших операций.
 */
async function setupAB(finalize = true): Promise<Stand> {
  const wh = await h.warehouse.create(seed.workspaceId, { name: 'Деталь' }, seed.userId);
  const warehouseItemId = wh!.id;
  // Партия A: 5@100, receivedAt раньше.
  await h.purchases.register(seed.workspaceId, seed.userId, {
    accountId: seed.accountId,
    date: '2026-01-01T00:00:00.000Z',
    lines: [{ warehouseItemId, qty: '5', unitPrice: '100' }],
  });
  // Партия B: 5@200, receivedAt позже.
  await h.purchases.register(seed.workspaceId, seed.userId, {
    accountId: seed.accountId,
    date: '2026-02-01T00:00:00.000Z',
    lines: [{ warehouseItemId, qty: '5', unitPrice: '200' }],
  });
  const order = await h.orders.create(seed.workspaceId, {
    items: [{ warehouseItemId, name: 'Деталь', qty: '10', unitPrice: '300' }],
  });
  const orderItemId = order.items![0]!.id;
  if (finalize) await h.orders.finalize(seed.workspaceId, order.id, seed.userId);
  return { warehouseItemId, orderId: order.id, orderItemId };
}

async function getOrderItem(orderItemId: string) {
  return h.prisma.orderItem.findUniqueOrThrow({ where: { id: orderItemId } });
}
async function getItem(id: string) {
  return h.prisma.warehouseItem.findUniqueOrThrow({ where: { id } });
}
async function lotsOf(warehouseItemId: string) {
  return h.prisma.stockLot.findMany({
    where: { warehouseItemId, deletedAt: null },
    orderBy: [{ receivedAt: 'asc' }, { seq: 'asc' }],
  });
}

describe('FIFO-маржа: finalize 10 ед через две партии', () => {
  it('FIFO списывает 5@100 + 5@200 → COGS=1500, unitCostAtSale=150', async () => {
    const { warehouseItemId, orderItemId } = await setupAB();

    // netCost = 5*100 + 5*200 = 1500; netQty = 10 → unitCostAtSale = 1500/10 = 150.
    const oi = await getOrderItem(orderItemId);
    expect(oi.unitCostAtSale!.toString()).toBe('150');
    expect(oi.shippedQty.toString()).toBe('10');

    // Обе партии исчерпаны: item.qty = 0.
    const item = await getItem(warehouseItemId);
    expect(item.qty.toString()).toBe('0');

    // Отчёт маржи: netQty=10, выручка=10*300=3000, cogs=10*150=1500, маржа=1500.
    const rep = await h.tradeMargin.byProduct(seed.workspaceId);
    expect(rep.totals.revenue).toBe('3000.00');
    expect(rep.totals.cogs).toBe('1500.00');
    expect(rep.totals.margin).toBe('1500.00');
  });
});

describe('FIFO-маржа: частичный возврат 5 ед (адресный LIFO-реверс)', () => {
  it('возврат восстанавливает ПОСЛЕДНЮЮ списанную партию B; margin cogs = 500 (а не 750)', async () => {
    const { warehouseItemId, orderId, orderItemId } = await setupAB();

    // Возврат 5 ед. LIFO: последним списали партию B (5@200) → её и восстанавливаем.
    await h.orders.returnItem(seed.workspaceId, orderId, seed.userId, {
      itemId: orderItemId,
      returnQty: '5',
      refundAmount: '0',
      accountId: seed.accountId,
    });

    // Партия B вернулась (qtyRemaining=5), партия A осталась списанной (0).
    const lots = await lotsOf(warehouseItemId);
    const lotA = lots.find((l) => l.unitCost.toString() === '100')!;
    const lotB = lots.find((l) => l.unitCost.toString() === '200')!;
    expect(lotA.qtyRemaining.toString()).toBe('0');
    expect(lotB.qtyRemaining.toString()).toBe('5');
    expect((await getItem(warehouseItemId)).qty.toString()).toBe('5');

    // net-леджер: +5@100, +5@200, −5@200 → netQty=5, netCost=500 → unitCostAtSale=100.
    const oi = await getOrderItem(orderItemId);
    expect(oi.returnedQty.toString()).toBe('5');
    expect(oi.unitCostAtSale!.toString()).toBe('100'); // остались проданными 5 ед партии A

    // КЛЮЧЕВОЕ: margin считает по оставшимся проданным. netQty = 10 − 5 = 5,
    // cogs = 5 * 100 = 500 (FIFO-COGS оставшихся), НЕ 5 * 150 = 750.
    const rep = await h.tradeMargin.byProduct(seed.workspaceId);
    expect(rep.totals.cogs).toBe('500.00');
    expect(rep.totals.revenue).toBe('1500.00'); // 5 * 300
    expect(rep.totals.margin).toBe('1000.00'); // 1500 − 500
  });
});

describe('FIFO-маржа: детерминизм reopen → refinalize и cancel без двойного реверса', () => {
  it('reopen после частичного возврата → refinalize даёт тот же FIFO-результат (150)', async () => {
    const { warehouseItemId, orderId, orderItemId } = await setupAB();
    await h.orders.returnItem(seed.workspaceId, orderId, seed.userId, {
      itemId: orderItemId,
      returnQty: '5',
      refundAmount: '0',
      accountId: seed.accountId,
    });

    // reopen откатывает остаток отгрузки (netOut = qty 10 − returnedQty 5 = 5):
    // реверсирует ОСТАВШУЮСЯ реверсируемость (партия A), не трогая уже вернувшуюся B.
    await h.orders.reopen(seed.workspaceId, orderId, seed.userId);

    // Обе партии снова полны (A=5, B=5); счётчики строки сброшены.
    const afterReopen = await lotsOf(warehouseItemId);
    expect(afterReopen.map((l) => l.qtyRemaining.toString()).sort()).toEqual(['5', '5']);
    expect((await getItem(warehouseItemId)).qty.toString()).toBe('10');
    const oiReopened = await getOrderItem(orderItemId);
    expect(oiReopened.returnedQty.toString()).toBe('0');
    expect(oiReopened.shippedQty.toString()).toBe('0');
    expect(oiReopened.unitCostAtSale).toBeNull();

    // refinalize: FIFO снова 5@100 + 5@200 → unitCostAtSale = 1500/10 = 150 (детерминизм).
    await h.orders.finalize(seed.workspaceId, orderId, seed.userId);
    const oi = await getOrderItem(orderItemId);
    expect(oi.unitCostAtSale!.toString()).toBe('150');
    expect((await getItem(warehouseItemId)).qty.toString()).toBe('0');
  });

  it('cancel после частичного RMA НЕ делает двойной реверс (не падает на CHECK qtyRemaining<=qtyInitial)', async () => {
    const { warehouseItemId, orderId } = await setupAB();
    const oiId = (await h.prisma.orderItem.findFirstOrThrow({ where: { orderId } })).id;
    await h.orders.returnItem(seed.workspaceId, orderId, seed.userId, {
      itemId: oiId,
      returnQty: '5',
      refundAmount: '0',
      accountId: seed.accountId,
    });

    // cancel реверсирует только НЕвозвращённый остаток (netOut = 10 − 5 = 5):
    // партия A восстанавливается; партия B (уже вернулась возвратом) не трогается.
    // Если бы реверс был двойным, B ушла бы за qtyInitial=5 → CHECK-violation.
    await expect(h.orders.cancel(seed.workspaceId, orderId, seed.userId)).resolves.toBeTruthy();

    const lots = await lotsOf(warehouseItemId);
    // Каждая партия не превышает qtyInitial и обе полны (5/5).
    for (const l of lots) {
      expect(new Prisma.Decimal(l.qtyRemaining).lessThanOrEqualTo(l.qtyInitial)).toBe(true);
    }
    expect(lots.map((l) => l.qtyRemaining.toString()).sort()).toEqual(['5', '5']);
    expect((await getItem(warehouseItemId)).qty.toString()).toBe('10');

    const order = await h.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('CANCELLED');
  });
});
