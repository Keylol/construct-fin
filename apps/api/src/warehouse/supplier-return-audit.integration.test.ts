/**
 * Волна 1, PR 1.4 (F6) — возврат поставщику пишет AuditLog + DE4-дата.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildHarness, resetDb, seedBase, type Harness, type Seed } from '../test/money-harness';

let h: Harness;
let seed: Seed;
let tg = 2795000n;

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

async function itemWithStock() {
  return h.warehouse.create(
    seed.workspaceId,
    { name: 'Деталь', openingQty: '10', openingCost: '100' },
    seed.userId,
  );
}

describe('F6: возврат поставщику', () => {
  it('пишет запись AuditLog (warehouse.supplier-return)', async () => {
    const item = await itemWithStock();
    await h.warehouse.supplierReturn(seed.workspaceId, item!.id, seed.userId, {
      returnQty: '3',
      refundAmount: '300',
      accountId: seed.accountId,
      date: '2026-05-01T00:00:00.000Z',
    });
    const audit = await h.prisma.auditLog.findFirst({
      where: { workspaceId: seed.workspaceId, action: 'warehouse.supplier-return' },
    });
    expect(audit).not.toBeNull();
    expect(audit!.entityId).toBe(item!.id);
  });

  it('DE4: будущая дата возврата поставщику отклоняется', async () => {
    const item = await itemWithStock();
    await expect(
      h.warehouse.supplierReturn(seed.workspaceId, item!.id, seed.userId, {
        returnQty: '3',
        refundAmount: '300',
        accountId: seed.accountId,
        date: '2099-01-01T00:00:00.000Z',
      }),
    ).rejects.toThrow(/будущем/);
  });
});
