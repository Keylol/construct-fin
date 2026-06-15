import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildHarness, resetDb, seedBase, type Harness, type Seed } from '../test/money-harness';

/**
 * F3 (Трек F): БД-уровневые CHECK-инварианты реально отвергают невалидные
 * данные (защита от прямого SQL/бага в обход сервиса). Проверяем несколько
 * репрезентативных ограничений — прямой insert мимо доменных сервисов.
 */

let h: Harness;
let seed: Seed;
let tg = 2100000n;

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

describe('F3: CHECK-ограничения БД', () => {
  it('WarehouseItem.qty < 0 → отклоняется БД', async () => {
    await expect(
      h.prisma.warehouseItem.create({
        data: { workspaceId: seed.workspaceId, name: 'Битая', qty: '-1' },
      }),
    ).rejects.toThrow();
  });

  it('WarehouseItem.avgCost < 0 → отклоняется БД', async () => {
    await expect(
      h.prisma.warehouseItem.create({
        data: { workspaceId: seed.workspaceId, name: 'Битая', avgCost: '-5' },
      }),
    ).rejects.toThrow();
  });

  it('OrderItem.shippedQty > qty → отклоняется БД', async () => {
    const order = await h.prisma.order.create({
      data: { workspaceId: seed.workspaceId, number: 'ORD-TEST-CHK1' },
    });
    await expect(
      h.prisma.orderItem.create({
        data: {
          orderId: order.id,
          name: 'X',
          qty: '2',
          unitPrice: '100',
          lineTotal: '200',
          shippedQty: '5', // > qty
        },
      }),
    ).rejects.toThrow();
  });

  it('Transfer.amount <= 0 → отклоняется БД', async () => {
    const to = await h.prisma.account.create({
      data: { workspaceId: seed.workspaceId, name: 'Банк', type: 'BANK' },
    });
    await expect(
      h.prisma.transfer.create({
        data: {
          workspaceId: seed.workspaceId,
          fromAccountId: seed.accountId,
          toAccountId: to.id,
          amount: '0', // нарушает CHECK amount>0 (остальные поля валидны)
          date: new Date(),
          createdById: seed.userId,
        },
      }),
    ).rejects.toThrow();
  });
});
