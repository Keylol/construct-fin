/**
 * E2E (DB-backed) тесты мультитенантной изоляции (cross-tenant guards).
 *
 * Проверяем, что id из тела запроса (счёт/категория/поставщик/складская позиция)
 * НЕ могут ссылаться на чужой workspace. Сервисы вызываются на уровне домена
 * (мимо WorkspaceGuard) — именно здесь живут assertBelongs-проверки.
 *
 * Закрывает находки арх-обзора (purchase/import/warehouse) — см.
 * docs/audit-2026-06-16.md и handoff 2026-06-18.
 *
 * Уникальный диапазон telegramId этого файла: 1700000n+.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  buildHarness,
  resetDb,
  seedBase,
  seedWarehouseItem,
  type Harness,
  type Seed,
} from '../test/money-harness';

let h: Harness;
let A: Seed; // «свой» workspace
let B: Seed; // «чужой» workspace
let tg = 1700000n;

beforeAll(() => {
  h = buildHarness();
});

afterAll(async () => {
  await h.prisma.$disconnect();
});

beforeEach(async () => {
  await resetDb(h.prisma);
  tg += 1n;
  A = await seedBase(h.prisma, tg);
  tg += 1n;
  B = await seedBase(h.prisma, tg);
});

describe('purchase.register — счёт/поставщик чужого workspace отклоняются', () => {
  it('чужой accountId → ошибка, проводка не создаётся', async () => {
    const itemA = await seedWarehouseItem(h.prisma, A.workspaceId, 'Гвозди A');
    await expect(
      h.purchases.register(A.workspaceId, A.userId, {
        accountId: B.accountId, // чужой счёт
        lines: [{ warehouseItemId: itemA, qty: '1', unitPrice: '100' }],
      }),
    ).rejects.toThrow(/Счёт не найден/);
    // Ничего не записалось.
    expect(await h.prisma.transaction.count({ where: { workspaceId: A.workspaceId } })).toBe(0);
    expect(await h.prisma.purchase.count({ where: { workspaceId: A.workspaceId } })).toBe(0);
  });

  it('чужой supplierId → ошибка', async () => {
    const itemA = await seedWarehouseItem(h.prisma, A.workspaceId, 'Гвозди A');
    const supplierB = await h.prisma.counterparty.create({
      data: { workspaceId: B.workspaceId, name: 'Поставщик B' },
    });
    await expect(
      h.purchases.register(A.workspaceId, A.userId, {
        accountId: A.accountId,
        supplierId: supplierB.id, // чужой поставщик
        lines: [{ warehouseItemId: itemA, qty: '1', unitPrice: '100' }],
      }),
    ).rejects.toThrow(/Поставщик не найден/);
  });
});

describe('warehouse — чужие ссылки отклоняются', () => {
  it('supplierReturn на чужой счёт → ошибка, INCOME не создаётся', async () => {
    const itemA = await seedWarehouseItem(h.prisma, A.workspaceId, 'Деталь A');
    // дать остаток, чтобы возврат прошёл логику количества
    await h.prisma.warehouseItem.update({
      where: { id: itemA },
      data: { qty: '10', avgCost: '50' },
    });
    await expect(
      h.warehouse.supplierReturn(A.workspaceId, itemA, A.userId, {
        returnQty: '1',
        refundAmount: '50',
        accountId: B.accountId, // чужой счёт
      }),
    ).rejects.toThrow(/Счёт не найден/);
    expect(await h.prisma.transaction.count({ where: { workspaceId: A.workspaceId } })).toBe(0);
  });

  it('create с defaultSupplierId чужого workspace → ошибка', async () => {
    const supplierB = await h.prisma.counterparty.create({
      data: { workspaceId: B.workspaceId, name: 'Поставщик B' },
    });
    await expect(
      h.warehouse.create(A.workspaceId, { name: 'Новая деталь', defaultSupplierId: supplierB.id }, A.userId),
    ).rejects.toThrow(/Поставщик не найден/);
    expect(await h.prisma.warehouseItem.count({ where: { workspaceId: A.workspaceId } })).toBe(0);
  });
});

describe('import.commit — счёт чужого workspace отклоняется', () => {
  // Категорию импорт больше не принимает (разметка ушла во «Входящие»), и вектор
  // «повесить чужую категорию» исчез вместе с полем. Остался счёт: это он решает,
  // в чьё пространство лягут строки и чей баланс сдвинется при их разборе.
  it('импорт на счёт другого пространства → ошибка, строк не появляется', async () => {
    await expect(
      h.importSvc.commit({
        workspaceId: A.workspaceId,
        userId: A.userId,
        body: {
          filename: 'x.csv',
          fileHash: 'hash-xt-1',
          source: 'GENERIC_CSV',
          accountId: B.accountId, // чужой счёт
          skipDuplicates: true,
          rows: [
            {
              date: '2025-03-15',
              amount: '100.00',
              type: 'EXPENSE',
              description: null,
              counterpartyName: null,
              importHash: 'ih-xt-1',
              isDuplicate: false,
            },
          ],
        },
      }),
    ).rejects.toThrow(/Account not found/);
    expect(await h.prisma.bankStatementLine.count({ where: { workspaceId: A.workspaceId } })).toBe(0);
    expect(await h.prisma.bankStatementLine.count({ where: { workspaceId: B.workspaceId } })).toBe(0);
  });
});
