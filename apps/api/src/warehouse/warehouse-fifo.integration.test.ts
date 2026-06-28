/**
 * Интеграционные тесты FIFO-склада (F0) против реальной БД construct_v6_test.
 * НЕ запускать локально мимоходом — общая БД :5433 (см. CLAUDE.md, гейт B).
 *
 * Партии (StockLot) — источник истины; WarehouseItem.qty/avgCost — derived-кэши.
 * Каждое числовое ожидание выведено из первых принципов (FIFO-расчёт в комментарии).
 *
 * Покрытие:
 *   • закупка → StockLot с трассой (purchaseLineId/supplierId/accountId/receivedAt);
 *   • FIFO-продажа через несколько партий + unitCostAtSale из net-леджера;
 *   • supplierReturn: приоритет партий поставщика + spill; M1 (avgCost не обнуляется);
 *   • adjust ± (списание партий / новая ADJUSTMENT-партия / 400 без цены);
 *   • setCost на нулевых партиях; create(openingQty) атомарно; stockValue из лотов.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  buildHarness,
  resetDb,
  seedBase,
  seedStockItem,
  type Harness,
  type Seed,
} from '../test/money-harness';

let h: Harness;
let seed: Seed;
let tg = 920000n;

const D = (v: Prisma.Decimal | string | number) => new Prisma.Decimal(v);

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

/** Пустая складская позиция (без партий) через сервис. */
async function makeItem(name = 'Деталь'): Promise<string> {
  const item = await h.warehouse.create(seed.workspaceId, { name }, seed.userId);
  return item!.id;
}

async function makeSupplier(name: string): Promise<string> {
  const c = await h.prisma.counterparty.create({
    data: { workspaceId: seed.workspaceId, name, role: 'SUPPLIER' },
  });
  return c.id;
}

async function getItem(id: string) {
  return h.prisma.warehouseItem.findUniqueOrThrow({ where: { id } });
}

/** Открытые партии позиции в FIFO-порядке (receivedAt, seq). */
async function openLots(itemId: string) {
  return h.prisma.stockLot.findMany({
    where: { warehouseItemId: itemId, deletedAt: null },
    orderBy: [{ receivedAt: 'asc' }, { seq: 'asc' }],
  });
}

describe('FIFO: закупка создаёт партию с трассой', () => {
  it('register → StockLot{PURCHASE} с purchaseLineId/supplierId/accountId/receivedAt; кэш avgCost из лотов', async () => {
    const itemId = await makeItem();
    const supplierId = await makeSupplier('ООО Поставщик');
    const date = '2026-03-01T00:00:00.000Z';
    await h.purchases.register(seed.workspaceId, seed.userId, {
      accountId: seed.accountId,
      supplierId,
      date,
      lines: [{ warehouseItemId: itemId, qty: '10', unitPrice: '100' }],
    });

    const lots = await openLots(itemId);
    expect(lots).toHaveLength(1);
    const l = lots[0]!;
    expect(l.sourceType).toBe('PURCHASE');
    expect(l.qtyInitial.toString()).toBe('10');
    expect(l.qtyRemaining.toString()).toBe('10');
    expect(l.unitCost.toString()).toBe('100');
    expect(l.purchaseLineId).not.toBeNull(); // сильная трасса к строке закупки (F5)
    expect(l.supplierId).toBe(supplierId);
    expect(l.accountId).toBe(seed.accountId);
    expect(l.receivedAt.toISOString()).toBe(new Date(date).toISOString());

    // avgCost-кэш = Σ(qtyRem*unitCost)/ΣqtyRem = (10*100)/10 = 100.
    const item = await getItem(itemId);
    expect(item.qty.toString()).toBe('10');
    expect(item.avgCost.toString()).toBe('100');

    // purchaseLineId указывает на реальную строку закупки.
    const line = await h.prisma.purchaseLine.findUniqueOrThrow({ where: { id: l.purchaseLineId! } });
    expect(line.warehouseItemId).toBe(itemId);
  });
});

describe('FIFO: продажа через несколько партий', () => {
  it('закупка 10@100 затем 10@200, продажа 15 → 10@100 + 5@200, COGS=2000, unitCostAtSale=133.3333', async () => {
    const itemId = await makeItem();
    // Две партии с разными receivedAt — детерминированный FIFO-порядок.
    await h.purchases.register(seed.workspaceId, seed.userId, {
      accountId: seed.accountId,
      date: '2026-01-01T00:00:00.000Z',
      lines: [{ warehouseItemId: itemId, qty: '10', unitPrice: '100' }],
    });
    await h.purchases.register(seed.workspaceId, seed.userId, {
      accountId: seed.accountId,
      date: '2026-02-01T00:00:00.000Z',
      lines: [{ warehouseItemId: itemId, qty: '10', unitPrice: '200' }],
    });

    const order = await h.orders.create(seed.workspaceId, {
      items: [{ warehouseItemId: itemId, name: 'Деталь', qty: '15', unitPrice: '500' }],
    });
    await h.orders.finalize(seed.workspaceId, order.id, seed.userId);

    // FIFO: 10 из L1 (@100) + 5 из L2 (@200). totalCost = 1000 + 1000 = 2000.
    const lots = await openLots(itemId);
    // L1 исчерпана → qtyRemaining=0; L2: 10 − 5 = 5.
    const l1 = lots.find((x) => x.unitCost.toString() === '100')!;
    const l2 = lots.find((x) => x.unitCost.toString() === '200')!;
    expect(l1.qtyRemaining.toString()).toBe('0');
    expect(l2.qtyRemaining.toString()).toBe('5');

    // item.qty = 20 − 15 = 5.
    const item = await getItem(itemId);
    expect(item.qty.toString()).toBe('5');

    // SALE-движение: qtyDelta=-15, unitCost = round(2000/15,4) = 133.3333.
    const sale = await h.prisma.stockMovement.findFirstOrThrow({
      where: { warehouseItemId: itemId, type: 'SALE' },
    });
    expect(sale.qtyDelta.toString()).toBe('-15');
    expect(sale.qtyAfter.toString()).toBe('5');
    expect(sale.unitCost!.toString()).toBe('133.3333');

    // Два CONSUME-потребления: 10 и 5.
    const cons = await h.prisma.lotConsumption.findMany({
      where: { movementId: sale.id, kind: 'CONSUME' },
      orderBy: { qty: 'desc' },
    });
    expect(cons.map((c) => c.qty.toString())).toEqual(['10', '5']);

    // OrderItem.unitCostAtSale = netCost/netQty = 2000/15 = 133.3333.
    const oi = await h.prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } });
    expect(oi.unitCostAtSale!.toString()).toBe('133.3333');
  });
});

describe('FIFO: supplierReturn (приоритет поставщика + spill, M1)', () => {
  it('возврат сначала из партий поставщика, затем spill на остальные FIFO', async () => {
    const itemId = await makeItem();
    const s1 = await makeSupplier('Поставщик-1');
    const s2 = await makeSupplier('Поставщик-2');
    // L1: 5@100 от S1 (раньше), L2: 5@200 от S2 (позже). item.qty = 10.
    await h.purchases.register(seed.workspaceId, seed.userId, {
      accountId: seed.accountId,
      supplierId: s1,
      date: '2026-01-01T00:00:00.000Z',
      lines: [{ warehouseItemId: itemId, qty: '5', unitPrice: '100' }],
    });
    await h.purchases.register(seed.workspaceId, seed.userId, {
      accountId: seed.accountId,
      supplierId: s2,
      date: '2026-02-01T00:00:00.000Z',
      lines: [{ warehouseItemId: itemId, qty: '5', unitPrice: '200' }],
    });

    // Возврат 7 поставщику S2: приоритет его партии (5), затем spill на S1 (2).
    await h.warehouse.supplierReturn(seed.workspaceId, itemId, seed.userId, {
      returnQty: '7',
      refundAmount: '1400',
      accountId: seed.accountId,
      supplierId: s2,
    });

    const lots = await openLots(itemId);
    const lotS1 = lots.find((x) => x.supplierId === s1)!;
    const lotS2 = lots.find((x) => x.supplierId === s2)!;
    // S2 списан первым целиком: 5 − 5 = 0. S1 spill: 5 − 2 = 3 (несмотря на FIFO-старшинство).
    expect(lotS2.qtyRemaining.toString()).toBe('0');
    expect(lotS1.qtyRemaining.toString()).toBe('3');

    // item.qty = 10 − 7 = 3.
    const item = await getItem(itemId);
    expect(item.qty.toString()).toBe('3');

    // RETURN_SUPPLIER-движение и INCOME/SUPPLIER_REFUND проводка.
    const mv = await h.prisma.stockMovement.findFirstOrThrow({
      where: { warehouseItemId: itemId, type: 'RETURN_SUPPLIER' },
    });
    expect(mv.qtyDelta.toString()).toBe('-7');
    const refund = await h.prisma.transaction.findFirstOrThrow({
      where: { workspaceId: seed.workspaceId, kind: 'SUPPLIER_REFUND' },
    });
    expect(refund.type).toBe('INCOME');
    expect(refund.amount.toFixed(2)).toBe('1400.00');
  });

  it('M1: avgCost НЕ обнуляется при refund > стоимости остатка (списываем лоты по их цене)', async () => {
    // OPENING-лот 10@100 (миграционный — supplierId=null). refund 5000 >> стоимости.
    const { id: itemId } = await seedStockItem(h.prisma, {
      workspaceId: seed.workspaceId,
      createdById: seed.userId,
      qty: '10',
      unitCost: '100',
    });
    await h.warehouse.supplierReturn(seed.workspaceId, itemId, seed.userId, {
      returnQty: '2',
      refundAmount: '5000', // намеренно больше стоимости возвращаемого (2*100=200)
      accountId: seed.accountId,
    });

    // FIFO списал 2 из лота по 100 → остаток 8@100. avgCost = (8*100)/8 = 100, НЕ 0.
    const item = await getItem(itemId);
    expect(item.qty.toString()).toBe('8');
    expect(item.avgCost.toFixed(2)).toBe('100.00');
    expect(item.avgCost.isZero()).toBe(false); // структурно: нет clamp (refund−value)/qty
    expect(item.avgCost.isNegative()).toBe(false);

    const lots = await openLots(itemId);
    expect(lots[0]!.qtyRemaining.toString()).toBe('8');
    expect(lots[0]!.unitCost.toString()).toBe('100');
  });

  it('supplierReturn по миграционной позиции (OPENING-лот supplierId=null) НЕ падает', async () => {
    // seedStockItem даёт OPENING-лот с supplierId=null. Возврат с указанным
    // поставщиком, у которого НЕТ своих партий → весь объём уходит в spill.
    const { id: itemId } = await seedStockItem(h.prisma, {
      workspaceId: seed.workspaceId,
      createdById: seed.userId,
      qty: '10',
      unitCost: '100',
    });
    const s = await makeSupplier('Поставщик-без-партий');
    await expect(
      h.warehouse.supplierReturn(seed.workspaceId, itemId, seed.userId, {
        returnQty: '3',
        refundAmount: '300',
        accountId: seed.accountId,
        supplierId: s,
      }),
    ).resolves.toBeTruthy();

    const item = await getItem(itemId);
    expect(item.qty.toString()).toBe('7'); // 10 − 3
  });
});

describe('FIFO: adjust (инвентаризация ±)', () => {
  it('adjust вниз → FIFO-списание партий (ADJUSTMENT-движение + потребление)', async () => {
    const { id: itemId } = await seedStockItem(h.prisma, {
      workspaceId: seed.workspaceId,
      createdById: seed.userId,
      qty: '10',
      unitCost: '100',
    });
    await h.warehouse.adjust(seed.workspaceId, itemId, { newQty: '7', reason: 'бой' }, seed.userId);

    // delta = 7 − 10 = −3 → списание 3 из OPENING-лота. Остаток 10 − 3 = 7.
    const lots = await openLots(itemId);
    expect(lots[0]!.qtyRemaining.toString()).toBe('7');

    const mv = await h.prisma.stockMovement.findFirstOrThrow({
      where: { warehouseItemId: itemId, type: 'ADJUSTMENT' },
    });
    expect(mv.qtyDelta.toString()).toBe('-3');
    expect(mv.qtyAfter.toString()).toBe('7');
    expect(mv.reason).toBe('бой');

    const cons = await h.prisma.lotConsumption.findFirstOrThrow({
      where: { movementId: mv.id, kind: 'CONSUME' },
    });
    expect(cons.qty.toString()).toBe('3');

    const item = await getItem(itemId);
    expect(item.qty.toString()).toBe('7');
  });

  it('adjust вверх БЕЗ открытых партий и без unitCost → 400', async () => {
    const itemId = await makeItem(); // qty 0, нет партий
    await expect(
      h.warehouse.adjust(seed.workspaceId, itemId, { newQty: '5' }, seed.userId),
    ).rejects.toThrow(/себестоимость|unitCost/i);
    // склад не тронут
    const item = await getItem(itemId);
    expect(item.qty.toString()).toBe('0');
    expect(await openLots(itemId)).toHaveLength(0);
  });

  it('adjust вверх с unitCost → создаёт ADJUSTMENT-партию', async () => {
    const itemId = await makeItem();
    await h.warehouse.adjust(
      seed.workspaceId,
      itemId,
      { newQty: '5', unitCost: '50', reason: 'излишек' },
      seed.userId,
    );
    // delta = +5 → новая партия 5@50. item.qty=5, avgCost=(5*50)/5=50.
    const lots = await openLots(itemId);
    expect(lots).toHaveLength(1);
    expect(lots[0]!.sourceType).toBe('ADJUSTMENT');
    expect(lots[0]!.qtyInitial.toString()).toBe('5');
    expect(lots[0]!.unitCost.toString()).toBe('50');

    const item = await getItem(itemId);
    expect(item.qty.toString()).toBe('5');
    expect(item.avgCost.toString()).toBe('50');

    const mv = await h.prisma.stockMovement.findFirstOrThrow({
      where: { warehouseItemId: itemId, type: 'ADJUSTMENT' },
    });
    expect(mv.qtyDelta.toString()).toBe('5');
  });
});

describe('FIFO: setCost на нулевых партиях', () => {
  it('проставляет цену открытым нулевым партиям; последующая продажа берёт её в unitCostAtSale', async () => {
    // Неоценённый начальный остаток: OPENING-лот 10@0, avgCost=0.
    const { id: itemId } = await seedStockItem(h.prisma, {
      workspaceId: seed.workspaceId,
      createdById: seed.userId,
      qty: '10',
      unitCost: '0',
    });
    await h.warehouse.setCost(seed.workspaceId, itemId, { unitCost: '120' }, seed.userId);

    // Лот переоценён 0 → 120; кэш avgCost = 120.
    const lots = await openLots(itemId);
    expect(lots[0]!.unitCost.toString()).toBe('120');
    const item = await getItem(itemId);
    expect(item.avgCost.toString()).toBe('120');

    // Продажа 4 → unitCostAtSale = новая цена 120 (а не 0).
    const order = await h.orders.create(seed.workspaceId, {
      items: [{ warehouseItemId: itemId, name: 'Деталь', qty: '4', unitPrice: '300' }],
    });
    await h.orders.finalize(seed.workspaceId, order.id, seed.userId);
    const oi = await h.prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } });
    expect(oi.unitCostAtSale!.toString()).toBe('120');
  });
});

describe('FIFO: create(openingQty) атомарно', () => {
  it('создаёт OPENING-партию + движение; qty == Σ открытых qtyRemaining', async () => {
    const item = await h.warehouse.create(
      seed.workspaceId,
      { name: 'С остатком', openingQty: '10', openingCost: '100' },
      seed.userId,
    );
    const itemId = item!.id;

    const lots = await openLots(itemId);
    expect(lots).toHaveLength(1);
    expect(lots[0]!.sourceType).toBe('OPENING');
    expect(lots[0]!.qtyInitial.toString()).toBe('10');
    expect(lots[0]!.unitCost.toString()).toBe('100');

    const opening = await h.prisma.stockMovement.findFirstOrThrow({
      where: { warehouseItemId: itemId, type: 'OPENING' },
    });
    expect(opening.qtyDelta.toString()).toBe('10');

    // qty-кэш == Σ qtyRemaining открытых партий.
    const sumRem = lots.reduce((acc, l) => acc.plus(l.qtyRemaining), D(0));
    const fresh = await getItem(itemId);
    expect(fresh.qty.toString()).toBe(sumRem.toString());
    expect(fresh.qty.toString()).toBe('10');
  });
});

describe('FIFO: stockValue из лотов (без дрейфа)', () => {
  it('== Σ open(qtyRemaining*unitCost) на нескольких позициях, включая крупные qty', async () => {
    // A: 10@100 = 1000.00; B: 3.5@12.4 = 43.40; C: 250000@33.3333 = 8 333 325.00.
    // Σ = 1000 + 43.40 + 8333325 = 8 334 368.40.
    await seedStockItem(h.prisma, {
      workspaceId: seed.workspaceId,
      createdById: seed.userId,
      name: 'A',
      qty: '10',
      unitCost: '100',
    });
    await seedStockItem(h.prisma, {
      workspaceId: seed.workspaceId,
      createdById: seed.userId,
      name: 'B',
      qty: '3.5',
      unitCost: '12.4',
    });
    await seedStockItem(h.prisma, {
      workspaceId: seed.workspaceId,
      createdById: seed.userId,
      name: 'C',
      qty: '250000',
      unitCost: '33.3333',
    });

    // Независимый пересчёт прямо из лотов — авторитетная стоимость остатка.
    const lots = await h.prisma.stockLot.findMany({
      where: { workspaceId: seed.workspaceId, qtyRemaining: { gt: 0 }, deletedAt: null },
    });
    const expected = lots.reduce(
      (acc, l) => acc.plus(D(l.qtyRemaining).times(l.unitCost)),
      D(0),
    );

    const value = await h.warehouse.stockValue(seed.workspaceId);
    expect(value).toBe(expected.toFixed(2));
    expect(value).toBe('8334368.40');
  });
});
