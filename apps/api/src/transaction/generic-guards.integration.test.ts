/**
 * Волна 1, PR 1.1 — guard'ы generic-обхода доменных инвариантов шины:
 *   C1  — строки, порождённые доменом (ноги перевода + авто-комиссия, оплаты
 *         заказа), нельзя править/удалять через generic transaction-API.
 *   C16 — категория расхода не вешается на приход и наоборот (kind ↔ type).
 *   C3  — хвост «несведённых» в сверке исключает неденежные kind (как баланс).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { buildHarness, resetDb, seedBase, type Harness, type Seed } from '../test/money-harness';

let h: Harness;
let seed: Seed;
let tg = 2770000n;

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

async function makeAccount(name: string) {
  return h.prisma.account.create({
    data: { workspaceId: seed.workspaceId, name, type: 'BANK' },
  });
}

describe('C1: доменные строки нельзя трогать generic-API', () => {
  it('ногу перевода и комиссию нельзя ни удалить, ни переклассифицировать', async () => {
    const to = await makeAccount('Счёт Б');
    await h.transfer.create(seed.workspaceId, seed.userId, {
      fromAccountId: seed.accountId,
      toAccountId: to.id,
      amount: '10000',
      fee: '100',
      date: '2026-05-01T00:00:00.000Z',
    });
    const legs = await h.prisma.transaction.findMany({
      where: { workspaceId: seed.workspaceId, transferGroupId: { not: null } },
    });
    expect(legs.length).toBe(3); // TRANSFER_IN + TRANSFER_OUT + VARIABLE_COST-комиссия

    for (const leg of legs) {
      await expect(
        h.transactions.softDelete(seed.workspaceId, leg.id, seed.userId),
      ).rejects.toThrow(/перевода/);
      await expect(
        h.transactions.update(seed.workspaceId, leg.id, { kind: 'OTHER' }, seed.userId),
      ).rejects.toThrow(/перевода/);
    }
  });

  it('оплату/комиссию заказа нельзя удалить generic-API (только через карточку)', async () => {
    const order = await h.orders.create(seed.workspaceId, {
      phone: '+79000000000', items: [{ name: 'Кухня', qty: '1', unitPrice: '100000' }],
    });
    await h.orders.addInstallmentPayment(seed.workspaceId, order.id, seed.userId, {
      amount: '100000',
      fee: '5000',
      accountId: seed.accountId,
    });
    const rows = await h.prisma.transaction.findMany({
      where: { workspaceId: seed.workspaceId, orderId: order.id },
    });
    expect(rows.length).toBe(2); // ORDER_PAYMENT + VARIABLE_COST-комиссия рассрочки
    for (const r of rows) {
      await expect(
        h.transactions.softDelete(seed.workspaceId, r.id, seed.userId),
      ).rejects.toThrow(/заказу|автоматически/);
    }
  });

  it('ручная операция без доменных привязок правится и удаляется свободно', async () => {
    const tx = await h.transactions.create(seed.workspaceId, seed.userId, {
      date: '2026-05-01T00:00:00.000Z',
      amount: '500',
      type: 'EXPENSE',
      accountId: seed.accountId,
    });
    await expect(
      h.transactions.update(seed.workspaceId, tx.id, { amount: '600' }, seed.userId),
    ).resolves.toBeTruthy();
    await expect(
      h.transactions.softDelete(seed.workspaceId, tx.id, seed.userId),
    ).resolves.toBeUndefined();
  });
});

describe('C16: категория ↔ тип операции', () => {
  async function makeCategory(kind: 'INCOME' | 'EXPENSE') {
    return h.categories.create(seed.workspaceId, { name: `cat-${kind}`, kind, isFixedCost: false });
  }

  it('расход на доходную категорию → 400 (create)', async () => {
    const incomeCat = await makeCategory('INCOME');
    await expect(
      h.transactions.create(seed.workspaceId, seed.userId, {
        date: '2026-05-01T00:00:00.000Z',
        amount: '500',
        type: 'EXPENSE',
        accountId: seed.accountId,
        categoryId: incomeCat.id,
      }),
    ).rejects.toThrow(/доход/);
  });

  it('смена только type ломает совместимость с категорией → 400 (update)', async () => {
    const expenseCat = await makeCategory('EXPENSE');
    const tx = await h.transactions.create(seed.workspaceId, seed.userId, {
      date: '2026-05-01T00:00:00.000Z',
      amount: '500',
      type: 'EXPENSE',
      accountId: seed.accountId,
      categoryId: expenseCat.id,
    });
    await expect(
      h.transactions.update(seed.workspaceId, tx.id, { type: 'INCOME' }, seed.userId),
    ).rejects.toThrow(/расход/);
  });

  it('совпадающие kind↔type проходят', async () => {
    const expenseCat = await makeCategory('EXPENSE');
    await expect(
      h.transactions.create(seed.workspaceId, seed.userId, {
        date: '2026-05-01T00:00:00.000Z',
        amount: '500',
        type: 'EXPENSE',
        accountId: seed.accountId,
        categoryId: expenseCat.id,
      }),
    ).resolves.toBeTruthy();
  });
});

describe('C3: хвост несведённых исключает неденежные kind', () => {
  it('COGS не попадает в unreconciled (как и в книжный баланс)', async () => {
    // Денежная операция (видна в хвосте) + неденежный COGS (не должен).
    await h.transactions.create(seed.workspaceId, seed.userId, {
      date: '2026-05-01T00:00:00.000Z',
      amount: '1000',
      type: 'INCOME',
      accountId: seed.accountId,
    });
    await h.prisma.transaction.create({
      data: {
        workspaceId: seed.workspaceId,
        createdById: seed.userId,
        date: new Date('2026-05-02T00:00:00.000Z'),
        amount: new Prisma.Decimal('600'),
        type: 'EXPENSE',
        kind: 'COGS',
        accountId: seed.accountId,
      },
    });

    const rep = await h.reconciliation.build(seed.workspaceId, seed.accountId);
    const kinds = rep.unreconciled.operations.map((u) => u.kind);
    expect(kinds).toContain('OTHER'); // денежная операция в хвосте
    expect(kinds).not.toContain('COGS'); // неденежная — исключена
    // net хвоста считается только по денежным (1000 прихода, COGS не влияет).
    expect(rep.unreconciled.net).toBe('1000.00');
  });
});

describe('serialize: kind и editable в ответе (C18)', () => {
  it('ручная операция editable=true, доменная — editable=false', async () => {
    const manual = await h.transactions.create(seed.workspaceId, seed.userId, {
      date: '2026-05-01T00:00:00.000Z',
      amount: '500',
      type: 'EXPENSE',
      accountId: seed.accountId,
    });
    expect(manual).toMatchObject({ kind: 'OTHER', editable: true, transferGroupId: null });

    const to = await makeAccount('Счёт В');
    await h.transfer.create(seed.workspaceId, seed.userId, {
      fromAccountId: seed.accountId,
      toAccountId: to.id,
      amount: '1000',
      fee: '0',
      date: '2026-05-03T00:00:00.000Z',
    });
    const page = await h.transactions.list(seed.workspaceId, { limit: 50 });
    const leg = page.items.find((t) => t.transferGroupId !== null)!;
    expect(leg.editable).toBe(false);
  });
});
