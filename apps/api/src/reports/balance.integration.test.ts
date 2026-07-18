/**
 * Интеграционные тесты управленческого баланса на реальной БД: каждая строка
 * актива/обязательства из своего контура + равенство Активы − Обязательства =
 * Капитал. Методология accrual (IJ9): дебиторка — только закрытые заказы,
 * предоплаты открытых — авансы клиентов (обязательство).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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
let tg = 3_200_000n;

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

describe('Управленческий баланс', () => {
  it('пустое пространство: нули везде, равенство сходится', async () => {
    const b = await h.balance.build(seed.workspaceId);
    expect(b.assets.cash.total).toBe('0.00');
    expect(b.assets.receivables).toBe('0.00');
    expect(b.assets.inventory).toBe('0.00');
    expect(b.liabilities.customerAdvances).toBe('0.00');
    expect(b.liabilities.taxDue).toBe('0.00');
    expect(b.equity).toBe('0.00');
  });

  it('каждая строка из своего контура + Активы − Обязательства = Капитал', async () => {
    // Деньги: начальный остаток 100 000, +50 000 дохода, −20 000 расхода → 130 000.
    await h.prisma.account.update({
      where: { id: seed.accountId },
      data: { openingBalance: '100000.00' },
    });
    await h.prisma.transaction.createMany({
      data: [
        {
          workspaceId: seed.workspaceId,
          accountId: seed.accountId,
          type: 'INCOME',
          kind: 'ORDER_PAYMENT',
          amount: '50000.00',
          date: new Date(),
          createdById: seed.userId,
        },
        {
          workspaceId: seed.workspaceId,
          accountId: seed.accountId,
          type: 'EXPENSE',
          kind: 'FIXED_COST',
          amount: '20000.00',
          date: new Date(),
          createdById: seed.userId,
        },
      ],
    });

    // Запасы: 10 шт × 1 500 = 15 000 (FIFO-лот).
    await seedStockItem(h.prisma, {
      workspaceId: seed.workspaceId,
      createdById: seed.userId,
      qty: '10',
      unitCost: '1500.00',
    });

    // Закрытый недоплаченный заказ → дебиторка 15 000 (40 000 − 25 000).
    await h.prisma.order.create({
      data: {
        workspaceId: seed.workspaceId,
        number: 'A-1',
        status: 'DONE',
        paymentStatus: 'PARTIAL',
        totalAmount: '40000.00',
        paidAmount: '25000.00',
        closedAt: new Date(),
      },
    });
    // Открытый заказ с предоплатой → аванс 10 000 (НЕ дебиторка).
    await h.prisma.order.create({
      data: {
        workspaceId: seed.workspaceId,
        number: 'A-2',
        status: 'OPEN',
        paymentStatus: 'PARTIAL',
        totalAmount: '60000.00',
        paidAmount: '10000.00',
      },
    });

    const b = await h.balance.build(seed.workspaceId);
    expect(b.assets.cash.total).toBe('130000.00');
    expect(b.assets.cash.accounts).toHaveLength(1);
    expect(b.assets.receivables).toBe('15000.00');
    expect(b.assets.inventory).toBe('15000.00');
    expect(b.assets.total).toBe('160000.00');
    expect(b.liabilities.customerAdvances).toBe('10000.00');
    // Доход/расход текущего месяца начисляют АУСН: max(20%×(50000−20000), 3%×50000).
    expect(b.liabilities.taxDue).toBe('6000.00');
    expect(b.liabilities.total).toBe('16000.00');
    expect(b.equity).toBe('144000.00');
    // Балансовое равенство.
    expect(Number(b.assets.total) - Number(b.liabilities.total)).toBeCloseTo(
      Number(b.equity),
      2,
    );
  });

  it('не смешивает: архивный счёт, отменённый заказ и чужое пространство вне баланса', async () => {
    // Архивный счёт с деньгами — не в балансе.
    await h.prisma.account.create({
      data: {
        workspaceId: seed.workspaceId,
        name: 'Старый',
        type: 'BANK',
        openingBalance: '99999.00',
        isArchived: true,
      },
    });
    // Отменённый заказ с «оплатой» — ни дебиторка, ни аванс.
    await h.prisma.order.create({
      data: {
        workspaceId: seed.workspaceId,
        number: 'C-1',
        status: 'CANCELLED',
        paymentStatus: 'PARTIAL',
        totalAmount: '5000.00',
        paidAmount: '1000.00',
      },
    });
    // Чужое пространство с активами.
    tg += 1n;
    const other = await seedBase(h.prisma, tg);
    await h.prisma.account.update({
      where: { id: other.accountId },
      data: { openingBalance: '777777.00' },
    });

    const b = await h.balance.build(seed.workspaceId);
    expect(b.assets.cash.total).toBe('0.00');
    expect(b.liabilities.customerAdvances).toBe('0.00');
    expect(b.equity).toBe('0.00');
  });

  it('неуплаченный АУСН попадает в обязательства (после уплаты — уходит)', async () => {
    // Май: доход 1 000 000 (SALE по кассе) → база без расходов, налог 20% = 200 000.
    const may = new Date(new Date().getFullYear(), 4, 15, 12);
    await h.prisma.transaction.create({
      data: {
        workspaceId: seed.workspaceId,
        accountId: seed.accountId,
        type: 'INCOME',
        kind: 'ORDER_PAYMENT',
        amount: '1000000.00',
        date: may,
        createdById: seed.userId,
      },
    });
    const before = await h.balance.build(seed.workspaceId);
    expect(Number(before.liabilities.taxDue)).toBeGreaterThan(0);

    // Уплата налога соответствующей суммой закрывает обязательство.
    await h.tax.markPaid(seed.workspaceId, seed.userId, {
      year: new Date().getFullYear(),
      month: 5,
      accountId: seed.accountId,
      amount: before.liabilities.taxDue,
      date: new Date().toISOString(),
    });
    const after = await h.balance.build(seed.workspaceId);
    expect(after.liabilities.taxDue).toBe('0.00');
  });
});
