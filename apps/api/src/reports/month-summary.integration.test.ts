/**
 * Интеграционные тесты «Итогов месяца»: отчёт считается поверх ОПиУ и сходится
 * с ним до копейки. Месяц с заказами, расходами двух подстатей одного корня,
 * зарплатой без статьи, прочим доходом и налогом АУСН по начислению; рядом —
 * закупка на склад и изъятие владельца, которые в расходы месяца не входят.
 *
 * Уникальный диапазон telegramId этого файла: 4100000n+.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { CategoryBucket, CategoryKind, TransactionKind, TxType } from '@prisma/client';
import { buildHarness, resetDb, seedBase, type Harness, type Seed } from '../test/money-harness';
import { MonthSummaryService } from './month-summary.service';
import { monthPeriod } from './month-summary.calc';

let h: Harness;
let seed: Seed;
let summary: MonthSummaryService;
let cashAccountId: string;
let tg = 4_100_000n;

beforeAll(() => {
  h = buildHarness();
  summary = new MonthSummaryService(h.prisma as never, h.pnl);
});
afterAll(async () => {
  await h.prisma.$disconnect();
});
beforeEach(async () => {
  await resetDb(h.prisma);
  tg += 1n;
  seed = await seedBase(h.prisma, tg);
  // Базовый счёт харнесса — касса, а наличные в базу АУСН не входят: для
  // налога операции идут по банку. Закупка и изъятие — отдельной кассой.
  await h.prisma.account.update({ where: { id: seed.accountId }, data: { type: 'BANK' } });
  cashAccountId = (
    await h.prisma.account.create({
      data: { workspaceId: seed.workspaceId, name: 'Касса', type: 'CASH' },
    })
  ).id;
});

/** Полдень дня марта 2025 по UTC+5. */
const mar = (day: number) => new Date(Date.UTC(2025, 2, day, 7, 0, 0));
/** Полдень дня февраля 2025 по UTC+5. */
const feb = (day: number) => new Date(Date.UTC(2025, 1, day, 7, 0, 0));

async function category(
  name: string,
  kind: CategoryKind,
  bucket: CategoryBucket,
  parentId: string | null = null,
): Promise<string> {
  const c = await h.prisma.category.create({
    data: { workspaceId: seed.workspaceId, name, kind, bucket, parentId },
  });
  return c.id;
}

async function tx(opts: {
  amount: string;
  type: TxType;
  kind: TransactionKind;
  date: Date;
  categoryId?: string | null;
  accountId?: string;
}): Promise<void> {
  await h.prisma.transaction.create({
    data: {
      workspaceId: seed.workspaceId,
      accountId: opts.accountId ?? seed.accountId,
      date: opts.date,
      amount: opts.amount,
      type: opts.type,
      kind: opts.kind,
      categoryId: opts.categoryId ?? null,
      createdById: seed.userId,
    },
  });
}

let orderSeq = 0;
async function order(opts: {
  status: 'OPEN' | 'DONE' | 'CANCELLED';
  closedAt?: Date;
  total: string;
  paid?: string;
  deleted?: boolean;
  items: { name: string; price: string; costAtSale?: string; deleted?: boolean }[];
}): Promise<{ id: string; number: string }> {
  orderSeq += 1;
  return h.prisma.order.create({
    data: {
      workspaceId: seed.workspaceId,
      number: `MS-${orderSeq}`,
      status: opts.status,
      closedAt: opts.closedAt ?? null,
      subtotal: opts.total,
      totalAmount: opts.total,
      paidAmount: opts.paid ?? '0',
      deletedAt: opts.deleted ? new Date() : null,
      items: {
        create: opts.items.map((i) => ({
          name: i.name,
          qty: '1',
          unitPrice: i.price,
          lineTotal: i.price,
          unitCostAtSale: i.costAtSale ?? null,
          deletedAt: i.deleted ? new Date() : null,
        })),
      },
    },
    select: { id: true, number: true },
  });
}

describe('Итоги месяца', () => {
  it('сходятся с ОПиУ: группы по корню и по виду, налог, прочие доходы, раскладки и проверки', async () => {
    const mkt = await category('Маркетинг', 'EXPENSE', 'VARIABLE');
    const ads = await category('Реклама', 'EXPENSE', 'VARIABLE', mkt);
    const promo = await category('Розыгрыши', 'EXPENSE', 'FIXED', mkt);
    const otherInc = await category('Прочие доходы', 'INCOME', 'OTHER');

    // ── Март 2025 ──
    // Продажи 105 000: ПК за 100 000 с закупкой 60 000 (подарок за 1 ₽ без
    // закупки и удалённая позиция проверку не поднимают) и заказ на 5 000 без
    // закупочной цены — его покажет «Готовность месяца».
    await order({
      status: 'DONE',
      closedAt: mar(10),
      total: '100000.00',
      items: [
        { name: 'ПК', price: '100000.00', costAtSale: '60000.0000' },
        { name: 'Коврик в подарок', price: '1.00' },
        { name: 'Старая позиция', price: '5000.00', deleted: true },
      ],
    });
    const noCost = await order({
      status: 'DONE',
      closedAt: mar(20),
      total: '5000.00',
      items: [{ name: 'Сборка', price: '5000.00' }],
    });
    // Удалённый закрытый заказ не считается нигде.
    await order({
      status: 'DONE',
      closedAt: mar(21),
      total: '9000.00',
      deleted: true,
      items: [{ name: 'Удалённый', price: '9000.00' }],
    });
    // Открытые заказы с предоплатой: живой считается, удалённый и отменённый — нет.
    await order({ status: 'OPEN', total: '30000.00', paid: '7000.00', items: [{ name: 'Аванс', price: '30000.00' }] });
    await order({ status: 'OPEN', total: '1000.00', paid: '500.00', deleted: true, items: [{ name: 'x', price: '1000.00' }] });
    await order({ status: 'CANCELLED', total: '1000.00', paid: '800.00', items: [{ name: 'y', price: '1000.00' }] });

    // Деньги по банку (база АУСН): оплаты 105 000 и прочий доход 1 000;
    // расходы — две подстатьи «Маркетинга» и зарплата без статьи.
    await tx({ amount: '105000.00', type: 'INCOME', kind: 'ORDER_PAYMENT', date: mar(5) });
    await tx({ amount: '8000.00', type: 'EXPENSE', kind: 'OTHER', date: mar(6), categoryId: ads });
    await tx({ amount: '2000.00', type: 'EXPENSE', kind: 'OTHER', date: mar(7), categoryId: promo });
    await tx({ amount: '20000.00', type: 'EXPENSE', kind: 'SALARY', date: mar(25) });
    await tx({ amount: '1000.00', type: 'INCOME', kind: 'OTHER', date: mar(26), categoryId: otherInc });
    // Закупка на склад и изъятие владельца — наличными: не расходы месяца.
    await tx({ amount: '50000.00', type: 'EXPENSE', kind: 'PURCHASE', date: mar(8), accountId: cashAccountId });
    await tx({ amount: '30000.00', type: 'EXPENSE', kind: 'CAPITAL_OUT', date: mar(9), accountId: cashAccountId });

    // ── Февраль 2025 (прошлый месяц) ──
    await order({
      status: 'DONE',
      closedAt: feb(15),
      total: '50000.00',
      items: [{ name: 'ПК', price: '50000.00', costAtSale: '20000.0000' }],
    });
    await tx({ amount: '50000.00', type: 'INCOME', kind: 'ORDER_PAYMENT', date: feb(10) });
    await tx({ amount: '15000.00', type: 'EXPENSE', kind: 'SALARY', date: feb(25) });

    // ── Входящие ──
    const conn = await h.prisma.integrationConnection.create({
      data: {
        workspaceId: seed.workspaceId,
        provider: 'FILE',
        accountId: seed.accountId,
        createdById: seed.userId,
      },
    });
    let lineSeq = 0;
    const bankLine = (date: Date, amount: string, direction: TxType, status: 'NEW' | 'RESOLVED' = 'NEW') =>
      h.prisma.bankStatementLine.create({
        data: {
          workspaceId: seed.workspaceId,
          connectionId: conn.id,
          externalId: `ms-${++lineSeq}`,
          date,
          amount,
          direction,
          status,
        },
      });
    await bankLine(mar(12), '3000.00', 'INCOME');
    await bankLine(mar(13), '1200.00', 'EXPENSE');
    // 31 марта 23:30 по UTC+5 — ещё март; 1 апреля 00:30 — уже апрель.
    await bankLine(new Date('2025-03-31T18:30:00.000Z'), '100.00', 'EXPENSE');
    await bankLine(new Date('2025-03-31T19:30:00.000Z'), '999.00', 'INCOME');
    await bankLine(mar(14), '500.00', 'EXPENSE', 'RESOLVED');

    const r = await summary.build(seed.workspaceId, '2025-03');

    // Чистая прибыль — ровно ОПиУ того же месяца (налог по начислению).
    const pnl = await h.pnl.build({
      workspaceId: seed.workspaceId,
      primary: monthPeriod('2025-03'),
      comparison: null,
      groupBy: 'month',
      taxMode: 'accrual',
    });
    expect(r.net).toBe(pnl.primary.totals.net);
    // Строки операций ОПиУ отдаёт только по запросу: экран ОПиУ не меняется.
    expect(pnl.primary.totals.lines).toBeUndefined();

    // АУСН марта: доход 106 000, расход 30 000 → 20 % × 76 000 = 15 200.
    // Прибыль: 105 000 + 1 000 − 60 000 − 8 000 − 22 000 − 15 200 = 800.
    expect(r).toMatchObject({
      month: '2025-03',
      from: '2025-02-28T19:00:00.000Z',
      to: '2025-03-31T18:59:59.999Z',
      ordersClosed: 2,
      sales: '105000.00',
      components: '60000.00',
      markup: '45000.00',
      expenses: '45200.00',
      otherIncome: '1000.00',
      net: '800.00',
    });
    expect(r.checks.identity).toEqual({ ok: true, diff: '0.00' });

    // Группы: зарплата без статьи, налог по начислению, «Маркетинг» из двух
    // подстатей. Закупка 50 000 и изъятие 30 000 не попали никуда.
    expect(r.groups.map((g) => [g.name, g.amount, g.prevAmount])).toEqual([
      ['Зарплата', '20000.00', '15000.00'],
      ['Налог', '15200.00', '7000.00'],
      ['Маркетинг', '10000.00', '0.00'],
    ]);
    const [salary, tax, marketing] = r.groups;
    expect(salary).toMatchObject({ key: 'salary', categoryIds: [], uncategorizedKinds: ['SALARY'], taxAccrual: false });
    expect(tax).toMatchObject({ key: 'tax', categoryIds: [], uncategorizedKinds: [], taxAccrual: true });
    expect(marketing).toMatchObject({ key: mkt, uncategorizedKinds: [], taxAccrual: false });
    expect([...marketing!.categoryIds].sort()).toEqual([ads, promo].sort());

    // Из каждых 100 ₽: 57,1 + 19,1 + 14,5 + 9,5 − 1,0 + 0,8 = 100.
    expect(r.per100).toEqual({ components: '57.1', expenses: '43.1', otherIncome: '1.0' });
    expect(r.groups.map((g) => g.per100)).toEqual(['19.1', '14.5', '9.5']);
    expect(r.markupPct).toBe('42.9');
    expect(r.netPct).toBe('0.8');

    // На один заказ (2 закрытых): 52 500 = 30 000 + 10 000 + 7 600 + 5 000 − 500 + 400.
    expect(r.perOrder).toEqual({
      sales: '52500',
      components: '30000',
      markup: '22500',
      expenses: '22600',
      otherIncome: '500',
    });
    expect(r.groups.map((g) => g.perOrder)).toEqual(['10000', '7600', '5000']);
    expect(r.netPerOrder).toBe('400');

    // Прошлый месяц: 50 000 − 20 000 − 15 000 − налог 7 000 (20 % × 35 000) = 8 000.
    expect(r.prev).toMatchObject({
      month: '2025-02',
      ordersClosed: 1,
      sales: '50000.00',
      components: '20000.00',
      markup: '30000.00',
      expenses: '22000.00',
      otherIncome: '0.00',
      net: '8000.00',
    });
    const prevPnl = await h.pnl.build({
      workspaceId: seed.workspaceId,
      primary: monthPeriod('2025-02'),
      comparison: null,
      groupBy: 'month',
      taxMode: 'accrual',
    });
    expect(r.prev.net).toBe(prevPnl.primary.totals.net);

    // Готовность месяца.
    expect(r.checks.inbox).toEqual({
      count: 3,
      incomeCount: 1,
      income: '3000.00',
      expenseCount: 2,
      expense: '1300.00',
    });
    expect(r.checks.ordersWithoutCost.count).toBe(1);
    expect(r.checks.ordersWithoutCost.orders.map((o) => o.number)).toEqual([noCost.number]);
    expect(r.checks.openPrepaid).toEqual({ count: 1, paid: '7000.00' });
  });

  it('месяц без продаж: долей и раскладки на заказ нет, тождество сходится', async () => {
    const rent = await category('Аренда', 'EXPENSE', 'FIXED');
    await tx({ amount: '12000.00', type: 'EXPENSE', kind: 'OTHER', date: mar(3), categoryId: rent });

    const r = await summary.build(seed.workspaceId, '2025-03');
    expect(r.ordersClosed).toBe(0);
    expect(r.sales).toBe('0.00');
    expect(r.per100).toBeNull();
    expect(r.perOrder).toBeNull();
    expect(r.markupPct).toBeNull();
    expect(r.netPct).toBeNull();
    expect(r.netPerOrder).toBeNull();
    expect(r.groups.map((g) => [g.name, g.amount, g.per100, g.perOrder])).toEqual([
      ['Аренда', '12000.00', null, null],
    ]);
    // Расход по банку уменьшает базу, но налога с нулевого дохода нет.
    expect(r.net).toBe('-12000.00');
    expect(r.checks.identity).toEqual({ ok: true, diff: '0.00' });
  });
});
