/**
 * Волна 2, PR 2.3 — GH9: отмена закупки для НЕТРОНУТЫХ партий.
 * Реверс склада (soft-delete партий + пересчёт) + soft-delete PURCHASE-проводки
 * и документа. Если товар из партий уже ушёл (продан/списан) — 400.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildHarness, resetDb, seedBase, type Harness, type Seed } from '../test/money-harness';

let h: Harness;
let seed: Seed;
let tg = 2820000n;

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

async function item(name: string) {
  const it = await h.warehouse.create(seed.workspaceId, { name }, seed.userId);
  return it!.id;
}
function qtyOf(id: string) {
  return h.prisma.warehouseItem
    .findUniqueOrThrow({ where: { id } })
    .then((i) => i.qty.toFixed(3));
}

describe('GH9: отмена закупки', () => {
  it('нетронутая закупка отменяется: партии убраны, склад и деньги откатаны, аудит', async () => {
    const a = await item('Деталь A');
    const purchase = await h.purchases.register(seed.workspaceId, seed.userId, {
      accountId: seed.accountId,
      date: '2026-05-01T00:00:00.000Z',
      lines: [{ warehouseItemId: a, qty: '10', unitPrice: '100' }],
    });
    expect(await qtyOf(a)).toBe('10.000');

    const res = await h.purchases.voidPurchase(seed.workspaceId, purchase.id, seed.userId);
    expect(res.ok).toBe(true);

    // Склад откатан.
    expect(await qtyOf(a)).toBe('0.000');
    // Партии soft-deleted.
    const lots = await h.prisma.stockLot.findMany({
      where: { warehouseItemId: a, deletedAt: null },
    });
    expect(lots.length).toBe(0);
    // PURCHASE-проводка и документ soft-deleted.
    const pur = await h.prisma.purchase.findUniqueOrThrow({ where: { id: purchase.id } });
    expect(pur.deletedAt).not.toBeNull();
    const tx = await h.prisma.transaction.findUniqueOrThrow({ where: { id: pur.transactionId } });
    expect(tx.deletedAt).not.toBeNull();
    // Аудит.
    const audit = await h.prisma.auditLog.findFirst({
      where: { workspaceId: seed.workspaceId, action: 'purchase.void' },
    });
    expect(audit!.entityId).toBe(purchase.id);
  });

  it('закупка с проданным товаром отменить нельзя → 400', async () => {
    const a = await item('Деталь B');
    const purchase = await h.purchases.register(seed.workspaceId, seed.userId, {
      accountId: seed.accountId,
      date: '2026-05-01T00:00:00.000Z',
      lines: [{ warehouseItemId: a, qty: '10', unitPrice: '100' }],
    });
    // Продаём 3 через заказ (finalize → FIFO-потребление партии).
    const order = await h.orders.create(seed.workspaceId, {
      items: [{ name: 'Деталь B', qty: '3', unitPrice: '200', warehouseItemId: a }],
    });
    await h.orders.finalize(seed.workspaceId, order.id, seed.userId);

    await expect(
      h.purchases.voidPurchase(seed.workspaceId, purchase.id, seed.userId),
    ).rejects.toThrow(/уже продан|возврат поставщику/);
    // Ничего не откатано.
    const pur = await h.prisma.purchase.findUniqueOrThrow({ where: { id: purchase.id } });
    expect(pur.deletedAt).toBeNull();
    expect(await qtyOf(a)).toBe('7.000');
  });

  it('многострочная закупка: обе позиции откатываются', async () => {
    const a = await item('Деталь C');
    const b = await item('Деталь D');
    const purchase = await h.purchases.register(seed.workspaceId, seed.userId, {
      accountId: seed.accountId,
      date: '2026-05-01T00:00:00.000Z',
      lines: [
        { warehouseItemId: a, qty: '5', unitPrice: '100' },
        { warehouseItemId: b, qty: '8', unitPrice: '50' },
      ],
    });
    await h.purchases.voidPurchase(seed.workspaceId, purchase.id, seed.userId);
    expect(await qtyOf(a)).toBe('0.000');
    expect(await qtyOf(b)).toBe('0.000');
  });

  it('повторная отмена той же закупки → 404', async () => {
    const a = await item('Деталь E');
    const purchase = await h.purchases.register(seed.workspaceId, seed.userId, {
      accountId: seed.accountId,
      date: '2026-05-01T00:00:00.000Z',
      lines: [{ warehouseItemId: a, qty: '4', unitPrice: '100' }],
    });
    await h.purchases.voidPurchase(seed.workspaceId, purchase.id, seed.userId);
    await expect(
      h.purchases.voidPurchase(seed.workspaceId, purchase.id, seed.userId),
    ).rejects.toThrow(/не найдена|уже отменена/);
  });

  it('после частичного возврата поставщику остаток изменён → отмена запрещена', async () => {
    const a = await item('Деталь F');
    const purchase = await h.purchases.register(seed.workspaceId, seed.userId, {
      accountId: seed.accountId,
      date: '2026-05-01T00:00:00.000Z',
      lines: [{ warehouseItemId: a, qty: '10', unitPrice: '100' }],
    });
    // Возврат поставщику 4 — трогает партию (LotConsumption).
    await h.warehouse.supplierReturn(seed.workspaceId, a, seed.userId, {
      returnQty: '4',
      refundAmount: '400',
      accountId: seed.accountId,
    });
    await expect(
      h.purchases.voidPurchase(seed.workspaceId, purchase.id, seed.userId),
    ).rejects.toThrow(/уже продан|списан|изменён|возврат поставщику/);
  });
});
