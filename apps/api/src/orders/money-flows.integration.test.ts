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

describe('P&L: классификация COGS (Фаза 3 п.15)', () => {
  // Период, покрывающий «сейчас» — finalize/addPayment ставят дату new Date().
  const currentMonth = () => {
    const now = new Date();
    return {
      from: new Date(now.getFullYear(), now.getMonth(), 1),
      to: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59),
    };
  };
  const bucketOf = (totals: { byBucket: { bucket: string; expense: string; income: string }[] }, b: string) =>
    totals.byBucket.find((x) => x.bucket === b)!;

  it('COGS попадает в бакет COGS, не дублируется в OTHER, и отчёт сходится сам с собой', async () => {
    const order = await h.orders.create(seed.workspaceId, {
      items: [{ name: 'Работа со своим материалом', qty: '2', unitPrice: '1000', unitCost: '300' }],
    });
    await h.orders.addPayment(seed.workspaceId, order.id, seed.userId, {
      amount: '2000',
      accountId: seed.accountId,
    });
    await h.orders.finalize(seed.workspaceId, order.id, seed.userId);

    const report = await h.pnl.build({
      workspaceId: seed.workspaceId,
      primary: currentMonth(),
      comparison: null,
      groupBy: 'month',
    });
    const totals = report.primary.totals;

    // Себестоимость 2*300 = 600 классифицирована в бакет COGS.
    expect(bucketOf(totals, 'COGS').expense).toBe('600.00');
    // И НЕ утекла в OTHER (раньше COGS без categoryId дублировался туда).
    expect(bucketOf(totals, 'OTHER').expense).toBe('0.00');
    // Отчёт сходится: headline cogs == расходная часть бакета COGS.
    expect(totals.cogs).toBe(bucketOf(totals, 'COGS').expense);
    // Валовая прибыль = выручка(оплата 2000) − COGS(600).
    expect(totals.income).toBe('2000.00');
    expect(totals.grossProfit).toBe('1400.00');
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

describe('Конкурентность склада: FOR UPDATE (Фаза 4 п.20)', () => {
  it('две параллельные продажи одной позиции не уходят в oversell', async () => {
    const itemId = await seedWarehouseItem(h.prisma, seed.workspaceId);
    await h.purchases.register(seed.workspaceId, seed.userId, {
      accountId: seed.accountId,
      lines: [{ warehouseItemId: itemId, qty: '5', unitPrice: '100' }],
    });

    // Каждая продажа списывает 4 из 5 — вместе это 8 > 5. Без FOR UPDATE обе
    // прочитали бы qty=5 и обе «успели» бы (lost update). С блокировкой строки
    // транзакции сериализуются: одна списывает 5→1, вторая видит 1 и падает.
    const sell = () =>
      h.prisma.$transaction((tx) =>
        h.warehouse.decrementForSale(tx, seed.workspaceId, itemId, '4', seed.userId),
      );
    const results = await Promise.allSettled([sell(), sell()]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // Списалась ровно одна продажа: 5 − 4 = 1, в минус не ушли.
    expect(num((await getItem(itemId)).qty)).toBe(1);
  });

  it('BR2: finalize услуги фиксирует unitCostAtSale = unitCost (снимок себестоимости)', async () => {
    const order = await h.orders.create(seed.workspaceId, {
      items: [{ name: 'Монтаж', qty: '2', unitPrice: '500', unitCost: '300' }],
    });
    await h.orders.addPayment(seed.workspaceId, order.id, seed.userId, {
      amount: '1000',
      accountId: seed.accountId,
    });
    await h.orders.finalize(seed.workspaceId, order.id, seed.userId);
    const it = await h.prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } });
    // BR2: ручная себестоимость заморожена снимком → отчёт маржи её увидит (BR1).
    expect(it.unitCostAtSale).not.toBeNull();
    expect(num(it.unitCostAtSale!)).toBe(300);
  });

  it('B2: два параллельных finalize одного заказа → ровно один COGS (лок строки)', async () => {
    // Ручная позиция (без склада) — складской FOR UPDATE тут НЕ защищает, только
    // лок строки заказа. Без него оба finalize прочитали бы status=OPEN и каждый
    // создал бы COGS-расход (двойной счёт себестоимости).
    const order = await h.orders.create(seed.workspaceId, {
      items: [{ name: 'Монтаж', qty: '2', unitPrice: '500', unitCost: '300' }],
    });
    await h.orders.addPayment(seed.workspaceId, order.id, seed.userId, {
      amount: '1000',
      accountId: seed.accountId,
    });

    const results = await Promise.allSettled([
      h.orders.finalize(seed.workspaceId, order.id, seed.userId),
      h.orders.finalize(seed.workspaceId, order.id, seed.userId),
    ]);
    // Оба могут зарезолвиться (второй — ранний возврат на DONE), но эффект один.
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

    const cogs = await h.prisma.transaction.findMany({
      where: { workspaceId: seed.workspaceId, orderId: order.id, kind: 'COGS', deletedAt: null },
    });
    expect(cogs).toHaveLength(1); // ровно один COGS, не два
    expect(num(cogs[0]!.amount)).toBe(600); // 2 × 300
    const done = await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(done.status).toBe('DONE');
  });
});
