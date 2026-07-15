/**
 * Функциональные тесты вкладки «Налог» АУСН (Ф4): «кнопка → HTTP → БД».
 * GET /reports/tax · POST /reports/tax/pay · POST /reports/tax/ausn.
 * Диапазон telegramId: 2730000n+.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildHttpApp, type HttpApp } from '../e2e/http-harness';
import { resetDb, seedBase, seedMember, type Seed } from '../test/money-harness';

let H: HttpApp;
let seed: Seed;
let token: string;
let tg = 2730000n;

beforeAll(async () => {
  H = await buildHttpApp();
});
afterAll(async () => {
  await H.app.close();
});
beforeEach(async () => {
  await resetDb(H.prisma);
  tg += 1n;
  seed = await seedBase(H.prisma, tg);
  await seedMember(H.prisma, seed.workspaceId, seed.userId);
  token = await H.jwtFor(seed.userId, tg);
});

async function txn(monthNo: number, amount: string, type: 'INCOME' | 'EXPENSE', kind: string) {
  await H.prisma.transaction.create({
    data: {
      workspaceId: seed.workspaceId,
      accountId: seed.accountId,
      date: new Date(`2026-${String(monthNo).padStart(2, '0')}-15T12:00:00.000Z`),
      amount,
      type,
      kind: kind as never,
      createdById: seed.userId,
    },
  });
}

describe('Функциональные мутации: налог (tax)', () => {
  it('GET /reports/tax?year → помесячный расчёт', async () => {
    const ws = seed.workspaceId;
    await txn(3, '100000.00', 'INCOME', 'ORDER_PAYMENT');
    await txn(3, '40000.00', 'EXPENSE', 'PURCHASE');

    const res = await H.inject({ method: 'GET', url: `/workspaces/${ws}/reports/tax?year=2026`, token });
    expect(res.statusCode).toBe(200);
    const rep = res.json<{
      year: number;
      rate: number;
      months: { month: string; base: string; taxDue: string; status: string }[];
      totals: { taxDue: string };
    }>();
    expect(rep.year).toBe(2026);
    expect(rep.rate).toBe(0.2);
    expect(rep.months).toHaveLength(12);
    const march = rep.months.find((m) => m.month === '2026-03')!;
    expect(march.base).toBe('60000.00');
    expect(march.taxDue).toBe('12000.00');
    expect(march.status).toBe('UNPAID');
    expect(rep.totals.taxDue).toBe('12000.00');
  });

  it('POST /reports/tax/pay → создаёт TAX-расход, статус PAID', async () => {
    const ws = seed.workspaceId;
    await txn(2, '100000.00', 'INCOME', 'ORDER_PAYMENT');
    await txn(2, '40000.00', 'EXPENSE', 'PURCHASE');

    const pay = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/reports/tax/pay`,
      token,
      payload: {
        year: 2026,
        month: 2,
        accountId: seed.accountId,
        amount: '12000.00',
        date: '2026-03-20T10:00:00.000Z',
      },
    });
    expect(pay.statusCode).toBe(201);

    const taxTx = await H.prisma.transaction.findFirstOrThrow({
      where: { workspaceId: ws, kind: 'TAX' },
    });
    expect(taxTx.taxPeriod).toBe('2026-02');
    expect(taxTx.amount.toFixed(2)).toBe('12000.00');

    const rep = await H.inject({ method: 'GET', url: `/workspaces/${ws}/reports/tax?year=2026`, token });
    const feb = rep.json<{ months: { month: string; status: string; taxPaid: string }[] }>()
      .months.find((m) => m.month === '2026-02')!;
    expect(feb.status).toBe('PAID');
    expect(feb.taxPaid).toBe('12000.00');
  });

  it('POST /reports/tax/ausn → переопределение маркировки меняет базу', async () => {
    const ws = seed.workspaceId;
    // Вклад собственника (не доход по умолчанию).
    const tx = await H.prisma.transaction.create({
      data: {
        workspaceId: ws,
        accountId: seed.accountId,
        date: new Date('2026-05-15T12:00:00.000Z'),
        amount: '80000.00',
        type: 'INCOME',
        kind: 'CAPITAL_IN',
        createdById: seed.userId,
      },
      select: { id: true },
    });

    let may = (
      await H.inject({ method: 'GET', url: `/workspaces/${ws}/reports/tax?year=2026`, token })
    ).json<{ months: { month: string; income: string }[] }>().months.find((m) => m.month === '2026-05')!;
    expect(may.income).toBe('0.00'); // вклад не в базе

    const patch = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/reports/tax/ausn`,
      token,
      payload: { transactionId: tx.id, ausnMark: 'INCOME' },
    });
    expect(patch.statusCode).toBe(201);

    may = (
      await H.inject({ method: 'GET', url: `/workspaces/${ws}/reports/tax?year=2026`, token })
    ).json<{ months: { month: string; income: string }[] }>().months.find((m) => m.month === '2026-05')!;
    expect(may.income).toBe('80000.00'); // переопределено в доход
  });

  it('без токена → 401, чужой workspace → 403', async () => {
    const ws = seed.workspaceId;
    const noAuth = await H.inject({ method: 'GET', url: `/workspaces/${ws}/reports/tax?year=2026` });
    expect(noAuth.statusCode).toBe(401);

    const stranger = await seedBase(H.prisma, tg + 400_000n);
    const strangerToken = await H.jwtFor(stranger.userId, tg + 400_000n);
    const foreign = await H.inject({
      method: 'GET',
      url: `/workspaces/${ws}/reports/tax?year=2026`,
      token: strangerToken,
    });
    expect(foreign.statusCode).toBe(403);
  });
});
