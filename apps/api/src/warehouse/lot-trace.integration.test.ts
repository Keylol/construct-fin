/**
 * F5 (#9): витрина трассировки партий против реальной БД construct_v6_test.
 *
 * openLots: открытые партии позиции с поставщиком/счётом закупки (FIFO-порядок).
 * lotTraceForOrder: net-потребление строк заказа по партиям — после частичного
 * возврата (адресный LIFO-реверс) трасса сужается до реально проданного.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildHarness, resetDb, seedBase, type Harness, type Seed } from '../test/money-harness';

let h: Harness;
let seed: Seed;
let tg = 2750000n;

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

async function makeSupplier(name: string) {
  return h.prisma.counterparty.create({
    data: { workspaceId: seed.workspaceId, name, role: 'SUPPLIER' },
  });
}

/** Две закупки у разных поставщиков: A (5@100, Иванов), B (5@200, Петров). */
async function setupTracedAB() {
  const wh = await h.warehouse.create(seed.workspaceId, { name: 'Деталь' }, seed.userId);
  const ivanov = await makeSupplier('Иванов');
  const petrov = await makeSupplier('Петров');
  await h.purchases.register(seed.workspaceId, seed.userId, {
    accountId: seed.accountId,
    supplierId: ivanov.id,
    date: '2026-01-01T00:00:00.000Z',
    lines: [{ warehouseItemId: wh!.id, qty: '5', unitPrice: '100' }],
  });
  await h.purchases.register(seed.workspaceId, seed.userId, {
    accountId: seed.accountId,
    supplierId: petrov.id,
    date: '2026-02-01T00:00:00.000Z',
    lines: [{ warehouseItemId: wh!.id, qty: '5', unitPrice: '200' }],
  });
  return { itemId: wh!.id, ivanov, petrov };
}

describe('F5: openLots — открытые партии позиции', () => {
  it('FIFO-порядок, поставщик и счёт закупки на каждой партии', async () => {
    const { itemId, ivanov } = await setupTracedAB();
    const lots = await h.warehouse.openLots(seed.workspaceId, itemId);
    expect(lots).toHaveLength(2);
    expect(lots[0]).toMatchObject({
      qtyRemaining: '5',
      unitCost: '100',
      sourceType: 'PURCHASE',
      supplier: { id: ivanov.id, name: 'Иванов' },
      account: { id: seed.accountId },
    });
    expect(lots[1]!.supplier!.name).toBe('Петров');
    expect(lots[1]!.unitCost).toBe('200');
  });

  it('исчерпанные партии не показываются; OPENING-партия без поставщика/счёта', async () => {
    const wh = await h.warehouse.create(
      seed.workspaceId,
      { name: 'Опенинг', openingQty: '3', openingCost: '50' },
      seed.userId,
    );
    const lots = await h.warehouse.openLots(seed.workspaceId, wh!.id);
    expect(lots).toHaveLength(1);
    expect(lots[0]).toMatchObject({ sourceType: 'OPENING', supplier: null, account: null });

    await h.warehouse.writeOff(
      seed.workspaceId,
      wh!.id,
      { qty: '3', reason: 'Всё списали' },
      seed.userId,
    );
    expect(await h.warehouse.openLots(seed.workspaceId, wh!.id)).toHaveLength(0);
  });
});

describe('F5: lotTraceForOrder — трасса строк заказа', () => {
  it('finalize через две партии → строка ссылается на обе с поставщиками', async () => {
    const { itemId } = await setupTracedAB();
    const order = await h.orders.create(seed.workspaceId, {
      phone: '+79000000000', items: [{ warehouseItemId: itemId, name: 'Деталь', qty: '7', unitPrice: '300' }],
    });
    await h.orders.finalize(seed.workspaceId, order.id, seed.userId);

    const trace = await h.orders.trace(seed.workspaceId, order.id);
    expect(trace.items).toHaveLength(1);
    const lots = trace.items[0]!.lots;
    // FIFO: 5 из партии Иванова + 2 из партии Петрова.
    expect(lots).toHaveLength(2);
    expect(lots[0]).toMatchObject({
      qty: '5',
      unitCost: '100',
      supplier: { name: 'Иванов' },
    });
    expect(lots[1]).toMatchObject({
      qty: '2',
      unitCost: '200',
      supplier: { name: 'Петров' },
    });
  });

  it('частичный возврат сужает трассу (LIFO-реверс): вернулась партия Петрова', async () => {
    const { itemId } = await setupTracedAB();
    const order = await h.orders.create(seed.workspaceId, {
      phone: '+79000000000', items: [{ warehouseItemId: itemId, name: 'Деталь', qty: '7', unitPrice: '300' }],
    });
    const itemLineId = order.items[0]!.id;
    await h.orders.finalize(seed.workspaceId, order.id, seed.userId);
    await h.orders.returnItem(seed.workspaceId, order.id, seed.userId, {
      itemId: itemLineId,
      returnQty: '2',
      refundAmount: '0',
      accountId: seed.accountId,
    });

    const trace = await h.orders.trace(seed.workspaceId, order.id);
    const lots = trace.items[0]!.lots;
    // LIFO-реверс вернул 2 ед Петрова → остались проданными только 5 Иванова.
    expect(lots).toHaveLength(1);
    expect(lots[0]).toMatchObject({ qty: '5', supplier: { name: 'Иванов' } });
  });

  it('заказ без потреблений (услуги/OPEN) → пустая трасса', async () => {
    const order = await h.orders.create(seed.workspaceId, {
      phone: '+79000000000', items: [{ name: 'Консультация', qty: '1', unitPrice: '500' }],
    });
    const trace = await h.orders.trace(seed.workspaceId, order.id);
    expect(trace.items).toHaveLength(0);
  });
});
