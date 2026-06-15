/**
 * Интеграционные тесты склада (Полоса B) против реальной БД construct_v6_test.
 * НЕ запускать локально мимоходом — общая БД :5433 (см. CLAUDE.md, гейт B).
 *
 * Покрытие:
 *   • B1: закупка/продажа/возврат пишут StockMovement с верными qtyDelta/qtyAfter.
 *   • B2: импорт склада дедуплицирует по name; OPENING-движение; нет Transaction.
 *   • B3: low-stock возвращает только позиции ниже точки дозаказа.
 *   • B4: adjust сохраняет reason; supplierReturn двигает qty/avg + транзакция.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  buildHarness,
  resetDb,
  seedBase,
  type Harness,
  type Seed,
} from '../test/money-harness';

let h: Harness;
let seed: Seed;
let tg = 910000n;

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

async function makeItem(over: Record<string, unknown> = {}) {
  const item = await h.prisma.warehouseItem.create({
    data: { workspaceId: seed.workspaceId, name: 'Деталь A', ...over },
  });
  return item.id;
}

describe('B1: журнал StockMovement', () => {
  it('закупка → PURCHASE-движение с +qty и пересчётом WAVG', async () => {
    const itemId = await makeItem();
    await h.purchases.register(seed.workspaceId, seed.userId, {
      accountId: seed.accountId,
      lines: [{ warehouseItemId: itemId, qty: '10', unitPrice: '100' }],
    });
    const mvs = await h.prisma.stockMovement.findMany({
      where: { warehouseItemId: itemId },
    });
    expect(mvs).toHaveLength(1);
    expect(mvs[0]!.type).toBe('PURCHASE');
    expect(mvs[0]!.qtyDelta.toString()).toBe('10');
    expect(mvs[0]!.qtyAfter.toString()).toBe('10');
    expect(mvs[0]!.refType).toBe('Purchase');
  });

  it('финализация заказа → SALE-движение с отрицательным qtyDelta', async () => {
    const itemId = await makeItem();
    await h.purchases.register(seed.workspaceId, seed.userId, {
      accountId: seed.accountId,
      lines: [{ warehouseItemId: itemId, qty: '10', unitPrice: '100' }],
    });
    const order = await h.orders.create(seed.workspaceId, {
      items: [{ warehouseItemId: itemId, name: 'Деталь A', qty: '4', unitPrice: '200' }],
    });
    await h.orders.finalize(seed.workspaceId, order.id, seed.userId);
    const sale = await h.prisma.stockMovement.findFirst({
      where: { warehouseItemId: itemId, type: 'SALE' },
    });
    expect(sale).not.toBeNull();
    expect(sale!.qtyDelta.toString()).toBe('-4');
    expect(sale!.qtyAfter.toString()).toBe('6');
  });
});

describe('B2: импорт склада', () => {
  it('commit создаёт позиции + OPENING-движения, без транзакций', async () => {
    const res = await h.warehouse.importCommit(seed.workspaceId, seed.userId, [
      { name: 'Болт', qty: '50', avgCost: '10', unit: 'шт', reorderPoint: '5' },
      { name: 'Гайка', qty: '30', avgCost: '5' },
    ]);
    expect(res).toEqual({ created: 2, skipped: 0 });
    const items = await h.prisma.warehouseItem.findMany({
      where: { workspaceId: seed.workspaceId },
    });
    expect(items).toHaveLength(2);
    const openings = await h.prisma.stockMovement.findMany({
      where: { workspaceId: seed.workspaceId, type: 'OPENING' },
    });
    expect(openings).toHaveLength(2);
    const txs = await h.prisma.transaction.findMany({
      where: { workspaceId: seed.workspaceId },
    });
    expect(txs).toHaveLength(0); // cash-basis: начальные остатки НЕ создают Transaction
  });

  it('повторный импорт того же name НЕ двоит позицию', async () => {
    await h.warehouse.importCommit(seed.workspaceId, seed.userId, [
      { name: 'Болт', qty: '50', avgCost: '10' },
    ]);
    const res = await h.warehouse.importCommit(seed.workspaceId, seed.userId, [
      { name: 'Болт', qty: '99', avgCost: '99' },
    ]);
    expect(res).toEqual({ created: 0, skipped: 1 });
    const items = await h.prisma.warehouseItem.findMany({
      where: { workspaceId: seed.workspaceId, name: 'Болт' },
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.qty.toString()).toBe('50'); // прежнее значение, не перезаписано
  });
});

describe('B3: low-stock', () => {
  it('возвращает только позиции с reorderPoint и qty <= reorderPoint', async () => {
    await makeItem({ name: 'Ниже порога', qty: '3', reorderPoint: '5' });
    await makeItem({ name: 'На пороге', qty: '5', reorderPoint: '5' });
    await makeItem({ name: 'Выше порога', qty: '10', reorderPoint: '5' });
    await makeItem({ name: 'Без порога', qty: '0', reorderPoint: null });
    await makeItem({ name: 'Архивная', qty: '1', reorderPoint: '5', isArchived: true });

    const low = await h.warehouse.lowStock(seed.workspaceId);
    const names = low.map((r) => r.name).sort();
    expect(names).toEqual(['На пороге', 'Ниже порога']);
  });
});

describe('B4: adjust + supplierReturn', () => {
  it('adjust сохраняет reason в ADJUSTMENT-движении', async () => {
    const itemId = await makeItem({ qty: '10', avgCost: '100' });
    await h.warehouse.adjust(seed.workspaceId, itemId, { newQty: '7', reason: 'бой' }, seed.userId);
    const mv = await h.prisma.stockMovement.findFirst({
      where: { warehouseItemId: itemId, type: 'ADJUSTMENT' },
    });
    expect(mv).not.toBeNull();
    expect(mv!.qtyDelta.toString()).toBe('-3');
    expect(mv!.qtyAfter.toString()).toBe('7');
    expect(mv!.reason).toBe('бой');
  });

  it('supplierReturn двигает qty/avg, пишет RETURN_SUPPLIER + INCOME-транзакцию', async () => {
    const itemId = await makeItem({ qty: '20', avgCost: '150' });
    await h.warehouse.supplierReturn(seed.workspaceId, itemId, seed.userId, {
      returnQty: '3',
      refundAmount: '600',
      accountId: seed.accountId,
    });
    const item = await h.prisma.warehouseItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(item.qty.toString()).toBe('17');
    expect(item.avgCost.toFixed(2)).toBe('141.18');

    const mv = await h.prisma.stockMovement.findFirst({
      where: { warehouseItemId: itemId, type: 'RETURN_SUPPLIER' },
    });
    expect(mv!.qtyDelta.toString()).toBe('-3');

    const tx = await h.prisma.transaction.findFirst({
      where: { workspaceId: seed.workspaceId },
    });
    expect(tx!.type).toBe('INCOME');
    expect(tx!.kind).toBe('SUPPLIER_REFUND'); // A6: контр-закупка, не OTHER
    expect(tx!.amount.toFixed(2)).toBe('600.00');
  });

  it('B6: supplierReturn с returnQty=0 → ошибка (защита от деления на ноль)', async () => {
    const itemId = await makeItem({ qty: '10', avgCost: '100' });
    await expect(
      h.warehouse.supplierReturn(seed.workspaceId, itemId, seed.userId, {
        returnQty: '0',
        refundAmount: '0',
        accountId: seed.accountId,
      }),
    ).rejects.toThrow();
    // склад не тронут
    const item = await h.prisma.warehouseItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(item.qty.toString()).toBe('10');
  });
});
