/**
 * Интеграционные тесты «установка себестоимости начального остатка» (setCost).
 * Кейс: позиция заведена остатком с avgCost=0 (как 26 позиций ИП Каменский).
 * Проверяем: цена ставится, КОЛИЧЕСТВО и ДЕНЬГИ не трогаются (нет Transaction),
 * пишется журнал ADJUSTMENT; будущая продажа берёт новую себестоимость; гварды.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
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
let tg = 2100000n;

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

/**
 * Позиция с остатком, но нулевой себестоимостью (как залитые начальные остатки).
 * FIFO: материализуем остаток OPENING-партией с unitCost=0 — именно ей setCost
 * проставит цену. Прямой create без партии оставил бы позицию «без лотов» →
 * recomputeCaches обнулил бы qty при первой же операции.
 */
async function zeroCostItem(qty = '10') {
  const { id } = await seedStockItem(h.prisma, {
    workspaceId: seed.workspaceId,
    createdById: seed.userId,
    name: 'Iron Pride X',
    qty,
    unitCost: '0',
  });
  return id;
}

describe('setCost — установка себестоимости начального остатка', () => {
  it('ставит avgCost, не трогает qty и НЕ создаёт денежную операцию; пишет журнал', async () => {
    const itemId = await zeroCostItem('10');

    await h.warehouse.setCost(seed.workspaceId, itemId, { unitCost: '150' }, seed.userId);

    const item = await h.prisma.warehouseItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(num(item.avgCost)).toBe(150);
    expect(num(item.qty)).toBe(10); // количество не изменилось

    // деньги НЕ двигаются (cash-basis: начальный остаток — не закупка)
    const txCount = await h.prisma.transaction.count({ where: { workspaceId: seed.workspaceId } });
    expect(txCount).toBe(0);

    // журнал движений: ADJUSTMENT с нулевым qtyDelta и новой себестоимостью
    const mv = await h.prisma.stockMovement.findFirstOrThrow({
      where: { workspaceId: seed.workspaceId, warehouseItemId: itemId, type: 'ADJUSTMENT' },
    });
    expect(num(mv.qtyDelta)).toBe(0);
    expect(num(mv.unitCost!)).toBe(150);
  });

  it('будущая продажа берёт новую себестоимость (unitCostAtSale)', async () => {
    const itemId = await zeroCostItem('10');
    await h.warehouse.setCost(seed.workspaceId, itemId, { unitCost: '150' }, seed.userId);

    const order = await h.orders.create(seed.workspaceId, {
      items: [{ warehouseItemId: itemId, name: 'Iron Pride X', qty: '2', unitPrice: '500' }],
    });
    await h.orders.finalize(seed.workspaceId, order.id, seed.userId);

    const oi = await h.prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } });
    expect(num(oi.unitCostAtSale!)).toBe(150); // продажа ушла по новой себестоимости
    expect(num((await h.prisma.warehouseItem.findUniqueOrThrow({ where: { id: itemId } })).qty)).toBe(8);
  });

  it('нельзя переоценить уже оценённую позицию (avgCost>0) → ошибка', async () => {
    const item = await h.prisma.warehouseItem.create({
      data: { workspaceId: seed.workspaceId, name: 'Уже с ценой', qty: '5', avgCost: '100' },
    });
    await expect(
      h.warehouse.setCost(seed.workspaceId, item.id, { unitCost: '200' }, seed.userId),
    ).rejects.toThrow(BadRequestException);
    // цена не изменилась
    expect(num((await h.prisma.warehouseItem.findUniqueOrThrow({ where: { id: item.id } })).avgCost)).toBe(100);
  });

  it('неположительная себестоимость отклоняется', async () => {
    const itemId = await zeroCostItem('10');
    await expect(
      h.warehouse.setCost(seed.workspaceId, itemId, { unitCost: '0' }, seed.userId),
    ).rejects.toThrow(BadRequestException);
  });

  it('нельзя задать себестоимость позиции с нулевым остатком', async () => {
    const item = await h.prisma.warehouseItem.create({
      data: { workspaceId: seed.workspaceId, name: 'Пусто', qty: '0', avgCost: '0' },
    });
    await expect(
      h.warehouse.setCost(seed.workspaceId, item.id, { unitCost: '150' }, seed.userId),
    ).rejects.toThrow(BadRequestException);
  });

  it('NotFound для чужого/несуществующего id', async () => {
    await expect(
      h.warehouse.setCost(seed.workspaceId, 'nope', { unitCost: '150' }, seed.userId),
    ).rejects.toThrow(NotFoundException);
  });
});
