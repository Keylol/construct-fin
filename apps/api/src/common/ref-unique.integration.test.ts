import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildHarness, resetDb, seedBase, type Harness, type Seed } from '../test/money-harness';

/**
 * F2 (Трек F): partial-unique на справочниках (WHERE deletedAt IS NULL).
 * Дубли активных записей отклоняются БД; soft-delete освобождает ключ
 * (можно завести запись с тем же именем после удаления).
 */

let h: Harness;
let seed: Seed;
let tg = 2200000n;

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

describe('F2: partial-unique справочников', () => {
  it('Account: дубль активного имени → отклоняется; после soft-delete — снова можно', async () => {
    await h.prisma.account.create({
      data: { workspaceId: seed.workspaceId, name: 'Касса', type: 'CASH' },
    });
    await expect(
      h.prisma.account.create({
        data: { workspaceId: seed.workspaceId, name: 'Касса', type: 'BANK' },
      }),
    ).rejects.toThrow();

    // soft-delete освобождает ключ
    const dup = await h.prisma.account.findFirstOrThrow({
      where: { workspaceId: seed.workspaceId, name: 'Касса' },
    });
    await h.prisma.account.update({ where: { id: dup.id }, data: { deletedAt: new Date() } });
    await expect(
      h.prisma.account.create({
        data: { workspaceId: seed.workspaceId, name: 'Касса', type: 'CASH' },
      }),
    ).resolves.toBeTruthy();
  });

  it('Counterparty: дубль ИНН → отклоняется; несколько без ИНН — допустимо', async () => {
    await h.prisma.counterparty.create({
      data: { workspaceId: seed.workspaceId, name: 'Поставщик А', role: 'SUPPLIER', inn: '7700000001' },
    });
    await expect(
      h.prisma.counterparty.create({
        data: { workspaceId: seed.workspaceId, name: 'Поставщик Б', role: 'SUPPLIER', inn: '7700000001' },
      }),
    ).rejects.toThrow();

    // inn=null не участвует в уникальности — несколько допустимо
    await h.prisma.counterparty.create({
      data: { workspaceId: seed.workspaceId, name: 'Клиент 1', role: 'CLIENT' },
    });
    await expect(
      h.prisma.counterparty.create({
        data: { workspaceId: seed.workspaceId, name: 'Клиент 2', role: 'CLIENT' },
      }),
    ).resolves.toBeTruthy();
  });

  it('Category: дубль (workspace, parent, name, kind) → отклоняется', async () => {
    await h.prisma.category.create({
      data: { workspaceId: seed.workspaceId, name: 'Реклама', kind: 'EXPENSE' },
    });
    await expect(
      h.prisma.category.create({
        data: { workspaceId: seed.workspaceId, name: 'Реклама', kind: 'EXPENSE' },
      }),
    ).rejects.toThrow();

    // другой kind — допустимо (часть ключа)
    await expect(
      h.prisma.category.create({
        data: { workspaceId: seed.workspaceId, name: 'Реклама', kind: 'INCOME' },
      }),
    ).resolves.toBeTruthy();
  });
});
