/**
 * Волна 1, PR 1.3 — F1/F2: позицию с ненулевым остатком нельзя ни удалить,
 * ни архивировать (её стоимость иначе тихо исчезает из stock-value/отчётов).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildHarness, resetDb, seedBase, type Harness, type Seed } from '../test/money-harness';

let h: Harness;
let seed: Seed;
let tg = 2790000n;

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

/** Позиция с остатком 5 (через начальный остаток). */
async function itemWithStock() {
  return h.warehouse.create(
    seed.workspaceId,
    { name: 'Деталь', openingQty: '5', openingCost: '100' },
    seed.userId,
  );
}

describe('F1: удаление позиции с остатком', () => {
  it('остаток > 0 → 400', async () => {
    const item = await itemWithStock();
    await expect(h.warehouse.remove(seed.workspaceId, item!.id)).rejects.toThrow(
      /остаток|спишите/,
    );
  });

  it('после списания в ноль — удаление проходит', async () => {
    const item = await itemWithStock();
    await h.warehouse.writeOff(seed.workspaceId, item!.id, { qty: '5', reason: 'Всё списали' }, seed.userId);
    await expect(h.warehouse.remove(seed.workspaceId, item!.id)).resolves.toMatchObject({ ok: true });
  });

  it('пустая позиция (без остатка) удаляется свободно', async () => {
    const empty = await h.warehouse.create(seed.workspaceId, { name: 'Пусто' }, seed.userId);
    await expect(h.warehouse.remove(seed.workspaceId, empty!.id)).resolves.toMatchObject({ ok: true });
  });
});

describe('F2: архивация позиции с остатком', () => {
  it('остаток > 0 → 400', async () => {
    const item = await itemWithStock();
    await expect(
      h.warehouse.update(seed.workspaceId, item!.id, { isArchived: true }),
    ).rejects.toThrow(/остаток|спишите/);
  });

  it('после списания в ноль — архивация проходит', async () => {
    const item = await itemWithStock();
    await h.warehouse.writeOff(seed.workspaceId, item!.id, { qty: '5', reason: 'Списали' }, seed.userId);
    const updated = await h.warehouse.update(seed.workspaceId, item!.id, { isArchived: true });
    expect(updated!.isArchived).toBe(true);
  });

  it('правка других полей у позиции с остатком не блокируется', async () => {
    const item = await itemWithStock();
    const updated = await h.warehouse.update(seed.workspaceId, item!.id, { note: 'заметка' });
    expect(updated!.note).toBe('заметка');
  });
});
