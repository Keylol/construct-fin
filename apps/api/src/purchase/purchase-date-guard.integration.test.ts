/**
 * Волна 1, PR 1.2 (доп. по ревью) — DE4 распространён на закупку:
 * дата закупки не может быть в будущем (консистентно с заказами).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildHarness, resetDb, seedBase, type Harness, type Seed } from '../test/money-harness';

let h: Harness;
let seed: Seed;
let tg = 2780000n;

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

describe('DE4: дата закупки', () => {
  it('будущая дата закупки отклоняется', async () => {
    const wh = await h.warehouse.create(seed.workspaceId, { name: 'Деталь' }, seed.userId);
    await expect(
      h.purchases.register(seed.workspaceId, seed.userId, {
        accountId: seed.accountId,
        date: '2099-01-01T00:00:00.000Z',
        lines: [{ warehouseItemId: wh!.id, qty: '5', unitPrice: '100' }],
      }),
    ).rejects.toThrow(/будущем/);
  });

  it('прошлая дата закупки проходит', async () => {
    const wh = await h.warehouse.create(seed.workspaceId, { name: 'Деталь' }, seed.userId);
    await expect(
      h.purchases.register(seed.workspaceId, seed.userId, {
        accountId: seed.accountId,
        date: '2026-01-01T00:00:00.000Z',
        lines: [{ warehouseItemId: wh!.id, qty: '5', unitPrice: '100' }],
      }),
    ).resolves.toBeTruthy();
  });
});
