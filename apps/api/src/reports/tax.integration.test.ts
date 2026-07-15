/**
 * Интеграционные тесты вкладки «Налог» АУСН Д−Р (Ф4): помесячный расчёт базы,
 * минимальный налог, нетто-возвраты, переопределение ausnMark, отметка уплаты.
 * Реальная БД construct_v6_test.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import {
  buildHarness,
  resetDb,
  seedBase,
  type Harness,
  type Seed,
} from '../test/money-harness';
import type { AusnMark, TransactionKind, TxType } from '@prisma/client';

let h: Harness;
let seed: Seed;
let tg = 950000n;

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

/** Проводка на середину месяца (UTC+5 → тот же бизнес-месяц). */
async function txn(
  monthNo: number,
  amount: string,
  type: TxType,
  kind: TransactionKind,
  ausnMark: AusnMark | null = null,
) {
  return h.prisma.transaction.create({
    data: {
      workspaceId: seed.workspaceId,
      accountId: seed.accountId,
      date: new Date(`2026-${String(monthNo).padStart(2, '0')}-15T12:00:00.000Z`),
      amount,
      type,
      kind,
      ausnMark,
      createdById: seed.userId,
    },
  });
}

describe('TaxService.yearReport', () => {
  it('база и налог 20%: доход 100000, расход 40000 → база 60000, налог 12000', async () => {
    await txn(3, '100000.00', 'INCOME', 'ORDER_PAYMENT');
    await txn(3, '40000.00', 'EXPENSE', 'PURCHASE');

    const rep = await h.tax.yearReport(seed.workspaceId, 2026);
    const march = rep.months.find((m) => m.month === '2026-03')!;
    expect(march.income).toBe('100000.00');
    expect(march.expense).toBe('40000.00');
    expect(march.base).toBe('60000.00');
    expect(march.taxCalc).toBe('12000.00'); // 20% × 60000
    expect(march.taxMin).toBe('3000.00'); // 3% × 100000
    expect(march.taxDue).toBe('12000.00'); // max
    expect(march.status).toBe('UNPAID');
    expect(march.dueDate.slice(0, 10)).toBe('2026-04-25');
    expect(rep.totals.income).toBe('100000.00');
    expect(rep.totals.taxDue).toBe('12000.00');
  });

  it('минимальный налог: доход 100000, расход 95000 → база 5000, налог = max(1000, 3000) = 3000', async () => {
    await txn(4, '100000.00', 'INCOME', 'ORDER_PAYMENT');
    await txn(4, '95000.00', 'EXPENSE', 'PURCHASE');

    const apr = (await h.tax.yearReport(seed.workspaceId, 2026)).months.find((m) => m.month === '2026-04')!;
    expect(apr.base).toBe('5000.00');
    expect(apr.taxCalc).toBe('1000.00'); // 20% × 5000
    expect(apr.taxMin).toBe('3000.00'); // 3% × 100000
    expect(apr.taxDue).toBe('3000.00'); // минималка выигрывает
  });

  it('убыток: расход > доход → база 0, но минимальный налог 3% с дохода платится', async () => {
    await txn(5, '50000.00', 'INCOME', 'ORDER_PAYMENT');
    await txn(5, '80000.00', 'EXPENSE', 'PURCHASE');

    const may = (await h.tax.yearReport(seed.workspaceId, 2026)).months.find((m) => m.month === '2026-05')!;
    expect(may.base).toBe('0.00');
    expect(may.taxCalc).toBe('0.00');
    expect(may.taxMin).toBe('1500.00'); // 3% × 50000
    expect(may.taxDue).toBe('1500.00');
  });

  it('нетто-возвраты: возврат клиенту минусует доход, возврат поставщика — расход', async () => {
    await txn(6, '100000.00', 'INCOME', 'ORDER_PAYMENT');
    await txn(6, '20000.00', 'EXPENSE', 'ORDER_REFUND'); // −доход
    await txn(6, '50000.00', 'EXPENSE', 'PURCHASE');
    await txn(6, '10000.00', 'INCOME', 'SUPPLIER_REFUND'); // −расход

    const jun = (await h.tax.yearReport(seed.workspaceId, 2026)).months.find((m) => m.month === '2026-06')!;
    expect(jun.income).toBe('80000.00'); // 100000 − 20000
    expect(jun.expense).toBe('40000.00'); // 50000 − 10000
    expect(jun.base).toBe('40000.00');
  });

  it('вне базы: переводы, вклад собственника, COGS, сам налог — не учитываются', async () => {
    await txn(7, '100000.00', 'INCOME', 'ORDER_PAYMENT');
    await txn(7, '500000.00', 'INCOME', 'CAPITAL_IN'); // вклад — не доход
    await txn(7, '30000.00', 'INCOME', 'TRANSFER_IN'); // перевод — не доход
    await txn(7, '30000.00', 'EXPENSE', 'TRANSFER_OUT'); // перевод — не расход
    await txn(7, '25000.00', 'EXPENSE', 'COGS'); // неденежное — не расход
    await txn(7, '9000.00', 'EXPENSE', 'TAX'); // сам налог — не расход

    const jul = (await h.tax.yearReport(seed.workspaceId, 2026)).months.find((m) => m.month === '2026-07')!;
    expect(jul.income).toBe('100000.00');
    expect(jul.expense).toBe('0.00');
    expect(jul.base).toBe('100000.00');
  });

  it('переопределение ausnMark приоритетнее авто-разбора', async () => {
    // Перевод, помеченный оператором как доход → в базу дохода.
    await txn(8, '70000.00', 'INCOME', 'TRANSFER_IN', 'INCOME');
    // Оплата заказа, помеченная «не учитывать» → вне базы.
    await txn(8, '40000.00', 'INCOME', 'ORDER_PAYMENT', 'NOT_COUNTED');

    const aug = (await h.tax.yearReport(seed.workspaceId, 2026)).months.find((m) => m.month === '2026-08')!;
    expect(aug.income).toBe('70000.00');
  });

  it('markPaid создаёт TAX-расход с taxPeriod → сверка «уплачено»/статус', async () => {
    // Даты уплаты — прошедшие относительно текущей даты (не будущее).
    await txn(2, '100000.00', 'INCOME', 'ORDER_PAYMENT');
    await txn(2, '40000.00', 'EXPENSE', 'PURCHASE'); // налог 12000

    await h.tax.markPaid(seed.workspaceId, seed.userId, {
      year: 2026,
      month: 2,
      accountId: seed.accountId,
      amount: '12000.00',
      date: '2026-03-20T10:00:00.000Z',
    });

    const rep = await h.tax.yearReport(seed.workspaceId, 2026);
    const feb = rep.months.find((m) => m.month === '2026-02')!;
    expect(feb.taxDue).toBe('12000.00');
    expect(feb.taxPaid).toBe('12000.00');
    expect(feb.status).toBe('PAID');
    expect(rep.totals.taxPaid).toBe('12000.00');

    // TAX-платёж (дата март) не попадает в расход базы (kind=TAX → NOT_COUNTED).
    const march = rep.months.find((m) => m.month === '2026-03')!;
    expect(march.expense).toBe('0.00');

    // Частичная оплата → PARTIAL (апрель: доход 100000 без расхода → налог 20000).
    await txn(4, '100000.00', 'INCOME', 'ORDER_PAYMENT');
    await h.tax.markPaid(seed.workspaceId, seed.userId, {
      year: 2026,
      month: 4,
      accountId: seed.accountId,
      amount: '1000.00',
      date: '2026-05-20T10:00:00.000Z',
    });
    const apr = (await h.tax.yearReport(seed.workspaceId, 2026)).months.find((m) => m.month === '2026-04')!;
    expect(apr.taxDue).toBe('20000.00');
    expect(apr.taxPaid).toBe('1000.00');
    expect(apr.status).toBe('PARTIAL');
  });

  it('markPaid: будущая дата и неположительная сумма → 400', async () => {
    await expect(
      h.tax.markPaid(seed.workspaceId, seed.userId, {
        year: 2099,
        month: 1,
        accountId: seed.accountId,
        amount: '1000.00',
        date: '2099-02-25T00:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      h.tax.markPaid(seed.workspaceId, seed.userId, {
        year: 2026,
        month: 1,
        accountId: seed.accountId,
        amount: '0',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
