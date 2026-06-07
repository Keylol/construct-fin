/**
 * Интеграционные тесты partial-unique на Order.number и WarehouseItem.sku
 * (Фаза 4 п.21) против реальной БД (construct_v6_test).
 *
 * Суть п.21: уникальность считается ТОЛЬКО среди активных строк
 * (deletedAt IS NULL). Поэтому после soft-delete номер/sku освобождается и
 * может быть переиспользован — чего глобальный @@unique не позволял.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildHarness, resetDb, seedBase, type Harness, type Seed } from '../test/money-harness';

let h: Harness;
let seed: Seed;
let tg = 800000n;

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

// Prisma маппит нарушение unique (Postgres 23505) в код P2002.
describe('Partial-unique Order.number (Фаза 4 п.21)', () => {
  it('запрещает второй АКТИВНЫЙ заказ с тем же номером', async () => {
    await h.prisma.order.create({ data: { workspaceId: seed.workspaceId, number: 'ORD-1' } });
    await expect(
      h.prisma.order.create({ data: { workspaceId: seed.workspaceId, number: 'ORD-1' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('разрешает переиспользовать номер после soft-delete', async () => {
    const first = await h.prisma.order.create({
      data: { workspaceId: seed.workspaceId, number: 'ORD-1' },
    });
    await h.prisma.order.update({ where: { id: first.id }, data: { deletedAt: new Date() } });
    // Тот же номер снова — теперь должно пройти (старый удалён).
    const second = await h.prisma.order.create({
      data: { workspaceId: seed.workspaceId, number: 'ORD-1' },
    });
    expect(second.id).not.toBe(first.id);
  });
});

describe('Partial-unique WarehouseItem.sku (Фаза 4 п.21)', () => {
  it('запрещает вторую АКТИВНУЮ позицию с тем же sku', async () => {
    await h.prisma.warehouseItem.create({
      data: { workspaceId: seed.workspaceId, name: 'A', sku: 'SKU-1' },
    });
    await expect(
      h.prisma.warehouseItem.create({
        data: { workspaceId: seed.workspaceId, name: 'B', sku: 'SKU-1' },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('разрешает переиспользовать sku после soft-delete', async () => {
    const first = await h.prisma.warehouseItem.create({
      data: { workspaceId: seed.workspaceId, name: 'A', sku: 'SKU-1' },
    });
    await h.prisma.warehouseItem.update({
      where: { id: first.id },
      data: { deletedAt: new Date() },
    });
    const second = await h.prisma.warehouseItem.create({
      data: { workspaceId: seed.workspaceId, name: 'A2', sku: 'SKU-1' },
    });
    expect(second.id).not.toBe(first.id);
  });

  it('допускает несколько активных позиций без sku (NULL не конфликтует)', async () => {
    await h.prisma.warehouseItem.create({ data: { workspaceId: seed.workspaceId, name: 'A' } });
    await expect(
      h.prisma.warehouseItem.create({ data: { workspaceId: seed.workspaceId, name: 'B' } }),
    ).resolves.toBeTruthy();
  });
});
