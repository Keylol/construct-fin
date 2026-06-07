/**
 * Интеграционные тесты partial-unique индекса на импортные транзакции
 * (Фаза 4 п.17) против реальной БД (construct_v6_test).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  buildHarness,
  resetDb,
  seedBase,
  type Harness,
  type Seed,
} from '../test/money-harness';

let h: Harness;
let seed: Seed;
let tg = 700000n;

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

function makeTx(over: Partial<Prisma.TransactionUncheckedCreateInput> = {}) {
  return {
    workspaceId: seed.workspaceId,
    accountId: seed.accountId,
    createdById: seed.userId,
    date: new Date('2026-05-01T00:00:00.000Z'),
    amount: new Prisma.Decimal('100.00'),
    type: 'EXPENSE' as const,
    importHash: 'hash-A',
    ...over,
  };
}

describe('Partial-unique importHash (Фаза 4 п.17)', () => {
  it('запрещает второй АКТИВНЫЙ дубль (workspaceId, importHash)', async () => {
    await h.prisma.transaction.create({ data: makeTx() });
    await expect(h.prisma.transaction.create({ data: makeTx() })).rejects.toMatchObject({
      code: 'P2002',
    });
  });

  it('разрешает дубль, если первая транзакция soft-deleted', async () => {
    const first = await h.prisma.transaction.create({ data: makeTx() });
    await h.prisma.transaction.update({
      where: { id: first.id },
      data: { deletedAt: new Date() },
    });
    // Тот же importHash снова — индекс частичный (WHERE deletedAt IS NULL).
    const second = await h.prisma.transaction.create({ data: makeTx() });
    expect(second.id).not.toBe(first.id);
  });

  it('разрешает одинаковый importHash в РАЗНЫХ воркспейсах', async () => {
    await h.prisma.transaction.create({ data: makeTx() });
    const other = await seedBase(h.prisma, (tg += 1n));
    const tx = await h.prisma.transaction.create({
      data: makeTx({
        workspaceId: other.workspaceId,
        accountId: other.accountId,
        createdById: other.userId,
      }),
    });
    expect(tx.workspaceId).toBe(other.workspaceId);
  });

  it('не мешает множеству ручных транзакций без importHash (null)', async () => {
    await h.prisma.transaction.create({ data: makeTx({ importHash: null }) });
    await h.prisma.transaction.create({ data: makeTx({ importHash: null }) });
    const count = await h.prisma.transaction.count({
      where: { workspaceId: seed.workspaceId, importHash: null, deletedAt: null },
    });
    expect(count).toBe(2);
  });
});
