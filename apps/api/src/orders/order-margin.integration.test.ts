/**
 * F1: маржа в DTO заказа (решение #4) против реальной БД construct_v6_test.
 *
 * Проверяет весь путь: create/get/мутации отдают блок margin на строках и
 * заказе; оценка по avgCost до выдачи (estimate) → факт FIFO после finalize
 * (actual); возвраты сужают маржу по netQty; цифры карточки сходятся с отчётом
 * маржи (trade-reports) — единый каскад BR1.
 *
 * Стенд повторяет канонический fifo-margin: партии A (5@100) + B (5@200),
 * заказ 10 ед @ 300 → avgCost = 150, FIFO-COGS = 1500.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildHarness, resetDb, seedBase, type Harness, type Seed } from '../test/money-harness';

let h: Harness;
let seed: Seed;
let tg = 2720000n;

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

/** Партии A (5@100) и B (5@200); заказ на 10 ед @ 300 (НЕ финализирован). */
async function setupAB() {
  const wh = await h.warehouse.create(seed.workspaceId, { name: 'Деталь' }, seed.userId);
  const warehouseItemId = wh!.id;
  await h.purchases.register(seed.workspaceId, seed.userId, {
    accountId: seed.accountId,
    date: '2026-01-01T00:00:00.000Z',
    lines: [{ warehouseItemId, qty: '5', unitPrice: '100' }],
  });
  await h.purchases.register(seed.workspaceId, seed.userId, {
    accountId: seed.accountId,
    date: '2026-02-01T00:00:00.000Z',
    lines: [{ warehouseItemId, qty: '5', unitPrice: '200' }],
  });
  const order = await h.orders.create(seed.workspaceId, {
    items: [{ warehouseItemId, name: 'Деталь', qty: '10', unitPrice: '300' }],
  });
  return { warehouseItemId, orderId: order.id, orderItemId: order.items![0]!.id };
}

describe('F1: маржа в DTO заказа', () => {
  it('OPEN со складской позицией: оценка по avgCost (estimate), выручка = totalAmount', async () => {
    const { orderId } = await setupAB();

    const order = await h.orders.get(seed.workspaceId, orderId);
    // Оценка: avgCost = (5*100 + 5*200)/10 = 150 → cogs = 10*150 = 1500.
    expect(order.margin).toEqual({
      revenue: '3000.00',
      cogs: '1500.00',
      margin: '1500.00',
      marginPct: '50.00',
      isEstimate: true,
    });
    expect(order.margin.revenue).toBe(order.totalAmount.toFixed(2));
    expect(order.items[0]!.margin).toEqual({
      revenue: '3000.00',
      cogs: '1500.00',
      margin: '1500.00',
      marginPct: '50.00',
      costSource: 'estimate',
    });
  });

  it('create сразу отдаёт маржу-оценку (не дожидаясь get)', async () => {
    const wh = await h.warehouse.create(seed.workspaceId, { name: 'Деталь' }, seed.userId);
    await h.purchases.register(seed.workspaceId, seed.userId, {
      accountId: seed.accountId,
      date: '2026-01-01T00:00:00.000Z',
      lines: [{ warehouseItemId: wh!.id, qty: '10', unitPrice: '100' }],
    });
    const order = await h.orders.create(seed.workspaceId, {
      items: [{ warehouseItemId: wh!.id, name: 'Деталь', qty: '2', unitPrice: '250' }],
    });
    expect(order.margin.isEstimate).toBe(true);
    expect(order.margin.cogs).toBe('200.00'); // 2 × avgCost 100
    expect(order.items[0]!.margin.costSource).toBe('estimate');
  });

  it('finalize: оценка становится фактом FIFO (actual), сходится с отчётом маржи', async () => {
    const { orderId } = await setupAB();

    const done = await h.orders.finalize(seed.workspaceId, orderId, seed.userId);
    // Факт FIFO: 5@100 + 5@200 = 1500 (здесь совпадает с оценкой — партии те же).
    expect(done.margin).toEqual({
      revenue: '3000.00',
      cogs: '1500.00',
      margin: '1500.00',
      marginPct: '50.00',
      isEstimate: false,
    });
    expect(done.items[0]!.margin.costSource).toBe('actual');

    const rep = await h.tradeMargin.byProduct(seed.workspaceId);
    expect(rep.totals.cogs).toBe(done.margin.cogs);
    expect(rep.totals.revenue).toBe(done.margin.revenue);
    expect(rep.totals.margin).toBe(done.margin.margin);
  });

  it('частичный возврат: маржа карточки по netQty сходится с отчётом (COGS 500, не 750)', async () => {
    const { orderId, orderItemId } = await setupAB();
    await h.orders.finalize(seed.workspaceId, orderId, seed.userId);

    const after = await h.orders.returnItem(seed.workspaceId, orderId, seed.userId, {
      itemId: orderItemId,
      returnQty: '5',
      refundAmount: '0',
      accountId: seed.accountId,
    });
    // Адресный LIFO-реверс вернул партию B → остались проданными 5@100.
    expect(after.margin).toEqual({
      revenue: '1500.00', // netQty 5 × 300
      cogs: '500.00', // 5 × 100 (FIFO оставшихся)
      margin: '1000.00',
      marginPct: '66.67',
      isEstimate: false,
    });

    const rep = await h.tradeMargin.byProduct(seed.workspaceId);
    expect(rep.totals.cogs).toBe(after.margin.cogs);
    expect(rep.totals.margin).toBe(after.margin.margin);
  });

  it('скидка входит в базу итога (totalAmount), по строкам не разносится', async () => {
    const order = await h.orders.create(seed.workspaceId, {
      discountAmount: '100.00',
      items: [{ name: 'Монтаж', qty: '1', unitPrice: '1000.00', unitCost: '300' }],
    });
    // totalAmount = 1000 − 100 = 900; COGS = 300 → маржа 600, 66.67%.
    expect(order.margin).toEqual({
      revenue: '900.00',
      cogs: '300.00',
      margin: '600.00',
      marginPct: '66.67',
      isEstimate: false,
    });
    expect(order.margin.revenue).toBe(order.totalAmount.toFixed(2));
    // Строка — без скидки: 1000/300/700.
    expect(order.items[0]!.margin).toEqual({
      revenue: '1000.00',
      cogs: '300.00',
      margin: '700.00',
      marginPct: '70.00',
      costSource: 'manual',
    });
  });

  it('услуга: без себестоимости 100% (R3); ручная — manual до и actual после finalize', async () => {
    const order = await h.orders.create(seed.workspaceId, {
      items: [
        { name: 'Консультация', qty: '2', unitPrice: '500.00' },
        { name: 'Монтаж', qty: '1', unitPrice: '1000.00', unitCost: '300' },
      ],
    });
    const [free, manual] = order.items;
    expect(free!.margin.marginPct).toBe('100.00');
    expect(free!.margin.costSource).toBeNull();
    expect(manual!.margin.costSource).toBe('manual');

    const done = await h.orders.finalize(seed.workspaceId, order.id, seed.userId);
    // BR2: finalize снапшотит unitCost → unitCostAtSale, источник становится actual.
    const doneManual = done.items.find((i) => i.name === 'Монтаж')!;
    expect(doneManual.margin.costSource).toBe('actual');
    expect(doneManual.margin.cogs).toBe('300.00');
    expect(done.margin.cogs).toBe('300.00');
  });
});
