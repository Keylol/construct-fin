/**
 * E2E (DB-backed) тесты домена «Отчёты»: P&L, Cashflow (консолид/по счёту),
 * разбивки by-category / by-counterparty, экспорт CSV/XLSX.
 *
 * Дополняет, а не дублирует:
 *   - pnl.service.test.ts / cashflow.service.test.ts / period.test.ts (юниты)
 *   - orders/money-flows.integration.test.ts (классификация COGS-бакета)
 * Здесь — end-to-end ПО ДАННЫМ: заводим Transaction/Account/Category/Counterparty
 * в живой БД, гоняем реальные сервисы, сверяем эффект в ответе и денежные суммы.
 *
 * Уникальный диапазон telegramId для этого файла: 1500000n+.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  buildHarness,
  resetDb,
  seedBase,
  type Harness,
  type Seed,
} from '../test/money-harness';
import { BreakdownService } from './breakdown.service';
import { renderReport } from './export';
import {
  breakdownToTable,
  cashflowToTable,
  pnlToTable,
} from './export/builders';
import type { Period } from './period';
import type {
  CategoryBucket,
  CategoryKind,
  CounterpartyRole,
  TransactionKind,
  TxType,
} from '@prisma/client';

let h: Harness;
let seed: Seed;
let breakdown: BreakdownService;
let tg = 1500000n; // уникальный диапазон telegramId этого файла

const num = (v: { toString(): string }) => Number(v.toString());

beforeAll(() => {
  h = buildHarness();
  // BreakdownService не отдаётся харнессом — инстанцируем поверх того же prisma.
  breakdown = new BreakdownService(h.prisma as never);
});

afterAll(async () => {
  await h.prisma.$disconnect();
});

beforeEach(async () => {
  await resetDb(h.prisma);
  tg += 1n;
  seed = await seedBase(h.prisma, tg);
});

// ───────────────────────── helpers ─────────────────────────

/** Период «весь 2025-й год» (фикс. даты — тесты детерминированы, не зависят от now). */
const Y2025: Period = {
  from: new Date(2025, 0, 1, 0, 0, 0),
  to: new Date(2025, 11, 31, 23, 59, 59, 999),
};

/** ISO-дата внутри 2025-го для конкретного месяца (0-based). */
const d2025 = (month: number, day = 15) => new Date(2025, month, day, 12, 0, 0);

let accSeq = 0;
async function makeAccount(opts: {
  name?: string;
  openingBalance?: string;
  class?: 'OPERATING' | 'TRANSIT' | 'PERSONAL';
}): Promise<string> {
  accSeq += 1;
  const a = await h.prisma.account.create({
    data: {
      workspaceId: seed.workspaceId,
      name: opts.name ?? `Счёт ${accSeq}`,
      type: 'BANK',
      class: opts.class ?? 'OPERATING',
      openingBalance: opts.openingBalance ?? '0',
    },
  });
  return a.id;
}

async function makeCategory(
  name: string,
  kind: CategoryKind,
  bucket: CategoryBucket,
): Promise<string> {
  const c = await h.prisma.category.create({
    data: { workspaceId: seed.workspaceId, name, kind, bucket },
  });
  return c.id;
}

async function makeCounterparty(
  name: string,
  role: CounterpartyRole = 'OTHER',
): Promise<string> {
  const cp = await h.prisma.counterparty.create({
    data: { workspaceId: seed.workspaceId, name, role },
  });
  return cp.id;
}

/** Прямая вставка транзакции (полный контроль над kind/type/date/категорией). */
async function tx(opts: {
  amount: string;
  type: TxType;
  kind?: TransactionKind;
  date: Date;
  accountId?: string;
  categoryId?: string | null;
  counterpartyId?: string | null;
}): Promise<void> {
  await h.prisma.transaction.create({
    data: {
      workspaceId: seed.workspaceId,
      date: opts.date,
      amount: opts.amount,
      type: opts.type,
      kind: opts.kind ?? 'OTHER',
      accountId: opts.accountId ?? seed.accountId,
      categoryId: opts.categoryId ?? null,
      counterpartyId: opts.counterpartyId ?? null,
      createdById: seed.userId,
    },
  });
}

const bucketOf = (
  totals: { byBucket: { bucket: string; expense: string; income: string }[] },
  b: string,
) => totals.byBucket.find((x) => x.bucket === b)!;

// ───────────────────────── P&L ─────────────────────────

describe('P&L отчёт (по данным)', () => {
  it('доход/расход по бакетам, grossProfit = выручка − COGS, ноги перевода исключены ПО kind', async () => {
    const revCat = await makeCategory('Продажи', 'INCOME', 'REVENUE');
    const fixedCat = await makeCategory('Аренда', 'EXPENSE', 'FIXED');
    const varCat = await makeCategory('Комиссия', 'EXPENSE', 'VARIABLE');
    const otherAcc = await makeAccount({ name: 'Запасной' });

    // Выручка 10000 (REVENUE) + COGS 3000 (по kind, без categoryId) + аренда 2000 (FIXED).
    await tx({ amount: '10000', type: 'INCOME', kind: 'ORDER_PAYMENT', date: d2025(2), categoryId: revCat });
    await tx({ amount: '3000', type: 'EXPENSE', kind: 'COGS', date: d2025(2), categoryId: null });
    await tx({ amount: '2000', type: 'EXPENSE', kind: 'FIXED_COST', date: d2025(2), categoryId: fixedCat });

    // Реальный перевод между своими счетами (через сервис → валидный Transfer
    // и обе ноги TRANSFER_IN/OUT). Ноги должны быть исключены ИЗ P&L ПО kind.
    await h.transfer.create(seed.workspaceId, seed.userId, {
      fromAccountId: seed.accountId,
      toAccountId: otherAcc,
      amount: '5000',
      fee: '0',
      date: d2025(2).toISOString(),
    });
    // Комиссия — реальный расход (VARIABLE_COST с категорией VARIABLE), остаётся в P&L.
    await tx({ amount: '50', type: 'EXPENSE', kind: 'VARIABLE_COST', date: d2025(2), categoryId: varCat });

    const report = await h.pnl.build({
      workspaceId: seed.workspaceId,
      primary: Y2025,
      comparison: null,
      groupBy: 'month',
    });
    const t = report.primary.totals;

    // Ноги перевода (5000 in + 5000 out) НЕ попали в доход/расход.
    expect(t.income).toBe('10000.00');
    expect(t.expense).toBe('5050.00'); // 3000 COGS + 2000 FIXED + 50 комиссия
    // COGS по kind → бакет COGS, не OTHER.
    expect(bucketOf(t, 'COGS').expense).toBe('3000.00');
    expect(bucketOf(t, 'OTHER').expense).toBe('0.00');
    // Комиссия перевода осталась в VARIABLE.
    expect(bucketOf(t, 'VARIABLE').expense).toBe('50.00');
    expect(bucketOf(t, 'FIXED').expense).toBe('2000.00');
    // grossProfit = выручка − COGS = 10000 − 3000.
    expect(t.grossProfit).toBe('7000.00');
    // net = доход − операционные расходы = 10000 − 5050.
    expect(t.net).toBe('4950.00');
    expect(report.comparison).toBeNull();
  });

  it('CAPITAL вычитается из net, но входит в grossProfit', async () => {
    const revCat = await makeCategory('Продажи', 'INCOME', 'REVENUE');
    const capInCat = await makeCategory('Вложение', 'INCOME', 'CAPITAL');
    const capOutCat = await makeCategory('Изъятие', 'EXPENSE', 'CAPITAL');

    await tx({ amount: '8000', type: 'INCOME', kind: 'ORDER_PAYMENT', date: d2025(4), categoryId: revCat });
    await tx({ amount: '20000', type: 'INCOME', kind: 'CAPITAL_IN', date: d2025(4), categoryId: capInCat });
    await tx({ amount: '5000', type: 'EXPENSE', kind: 'CAPITAL_OUT', date: d2025(4), categoryId: capOutCat });

    const report = await h.pnl.build({
      workspaceId: seed.workspaceId,
      primary: Y2025,
      comparison: null,
      groupBy: 'month',
    });
    const t = report.primary.totals;

    // Сырые income/expense включают CAPITAL.
    expect(t.income).toBe('28000.00'); // 8000 + 20000
    expect(t.expense).toBe('5000.00');
    // grossProfit считается от операционного дохода (без CAPITAL) минус COGS(0).
    expect(t.grossProfit).toBe('8000.00');
    // net = операц.доход(8000) − операц.расход(0) — оба CAPITAL вычтены.
    expect(t.net).toBe('8000.00');
    expect(bucketOf(t, 'CAPITAL').income).toBe('20000.00');
    expect(bucketOf(t, 'CAPITAL').expense).toBe('5000.00');
  });

  it('groupBy=month режет на месячные слайсы; groupBy=quarter — на квартальные', async () => {
    const revCat = await makeCategory('Продажи', 'INCOME', 'REVENUE');
    await tx({ amount: '1000', type: 'INCOME', kind: 'ORDER_PAYMENT', date: d2025(0), categoryId: revCat }); // Q1
    await tx({ amount: '2000', type: 'INCOME', kind: 'ORDER_PAYMENT', date: d2025(3), categoryId: revCat }); // Q2

    const byMonth = await h.pnl.build({
      workspaceId: seed.workspaceId,
      primary: Y2025,
      comparison: null,
      groupBy: 'month',
    });
    expect(byMonth.primary.buckets).toHaveLength(12); // весь год помесячно
    expect(byMonth.primary.buckets[0]!.label).toBe('2025-01');
    expect(byMonth.primary.buckets[0]!.income).toBe('1000.00');
    expect(byMonth.primary.buckets[3]!.income).toBe('2000.00');

    const byQuarter = await h.pnl.build({
      workspaceId: seed.workspaceId,
      primary: Y2025,
      comparison: null,
      groupBy: 'quarter',
    });
    expect(byQuarter.primary.buckets).toHaveLength(4);
    expect(byQuarter.primary.buckets[0]!.label).toBe('2025-Q1');
    expect(byQuarter.primary.buckets[0]!.income).toBe('1000.00');
    expect(byQuarter.primary.buckets[1]!.income).toBe('2000.00');
  });

  it('режим сравнения возвращает данные периода comparison', async () => {
    const revCat = await makeCategory('Продажи', 'INCOME', 'REVENUE');
    await tx({ amount: '5000', type: 'INCOME', kind: 'ORDER_PAYMENT', date: d2025(6), categoryId: revCat }); // primary
    await tx({ amount: '3000', type: 'INCOME', kind: 'ORDER_PAYMENT', date: new Date(2024, 6, 15), categoryId: revCat }); // yoy

    const primary: Period = { from: new Date(2025, 0, 1), to: new Date(2025, 11, 31, 23, 59, 59) };
    const comparison: Period = { from: new Date(2024, 0, 1), to: new Date(2024, 11, 31, 23, 59, 59) };

    const report = await h.pnl.build({ workspaceId: seed.workspaceId, primary, comparison, groupBy: 'month' });
    expect(report.primary.totals.income).toBe('5000.00');
    expect(report.comparison).not.toBeNull();
    expect(report.comparison!.totals.income).toBe('3000.00');
  });

  it('byCategory сортируется по убыванию суммарного оборота', async () => {
    const big = await makeCategory('Крупная', 'INCOME', 'REVENUE');
    const small = await makeCategory('Мелкая', 'INCOME', 'REVENUE');
    await tx({ amount: '100', type: 'INCOME', kind: 'ORDER_PAYMENT', date: d2025(1), categoryId: small });
    await tx({ amount: '900', type: 'INCOME', kind: 'ORDER_PAYMENT', date: d2025(1), categoryId: big });

    const report = await h.pnl.build({
      workspaceId: seed.workspaceId,
      primary: Y2025,
      comparison: null,
      groupBy: 'month',
    });
    const cats = report.primary.totals.byCategory.filter((c) => c.categoryId !== null);
    expect(cats[0]!.categoryName).toBe('Крупная');
    expect(num(cats[0]!.income)).toBeGreaterThan(num(cats[1]!.income));
  });
});

// ───────────────────────── Cashflow ─────────────────────────

describe('Cashflow отчёт (по данным)', () => {
  it('consolidated: openingBalance = сумма всех счетов, ноги перевода гасятся, комиссия остаётся оттоком', async () => {
    const acc2 = await makeAccount({ name: 'Банк', openingBalance: '1000' });
    // seed.accountId — opening 0; acc2 — opening 1000 → пул = 1000.
    const otherAcc = await makeAccount({ name: 'Транзит', openingBalance: '0', class: 'TRANSIT' });

    await tx({ amount: '5000', type: 'INCOME', kind: 'ORDER_PAYMENT', date: d2025(3), accountId: acc2 });
    await tx({ amount: '1000', type: 'EXPENSE', kind: 'FIXED_COST', date: d2025(3), accountId: acc2 });
    // Реальный перевод acc2 → otherAcc с комиссией 30: ноги (kind=TRANSFER_*)
    // гасятся в консолид., комиссия (kind=VARIABLE_COST) остаётся оттоком.
    await h.transfer.create(seed.workspaceId, seed.userId, {
      fromAccountId: acc2,
      toAccountId: otherAcc,
      amount: '2000',
      fee: '30',
      date: d2025(3).toISOString(),
    });

    const report = await h.cashflow.build({
      workspaceId: seed.workspaceId,
      period: { from: new Date(2025, 3, 1), to: new Date(2025, 3, 30, 23, 59, 59) },
      accountId: null,
      mode: 'consolidated',
    });
    expect(report.series).toHaveLength(1);
    const s = report.series[0]!;
    expect(s.accountId).toBeNull();
    expect(s.accountName).toBe('Все счета');
    expect(s.openingBalance).toBe('1000.00'); // 0 + 1000 + 0

    const apr = s.points.find((p) => p.label === '2025-04')!;
    // inflow: только реальный доход 5000 (TRANSFER_IN исключён).
    expect(apr.inflow).toBe('5000.00');
    // outflow: 1000 FIXED + 30 комиссия (TRANSFER_OUT исключён).
    expect(apr.outflow).toBe('1030.00');
    expect(apr.net).toBe('3970.00');
    // balance = opening(1000) + net(3970).
    expect(apr.balance).toBe('4970.00');
  });

  it('R2/C1: неденежный COGS не попадает в отток (consolidated и byAccount)', async () => {
    const acc = await makeAccount({ name: 'Касса cf-cogs', openingBalance: '0' });
    await tx({ amount: '1000', type: 'INCOME', kind: 'ORDER_PAYMENT', date: d2025(5), accountId: acc });
    await tx({ amount: '300', type: 'EXPENSE', kind: 'COGS', date: d2025(5), accountId: acc });
    const period = { from: new Date(2025, 5, 1), to: new Date(2025, 5, 30, 23, 59, 59) };

    const cons = await h.cashflow.build({ workspaceId: seed.workspaceId, period, accountId: null, mode: 'consolidated' });
    const cp = cons.series[0]!.points.find((p) => p.label === '2025-06')!;
    expect(cp.inflow).toBe('1000.00');
    expect(cp.outflow).toBe('0.00'); // COGS исключён — не движение денег

    const byAcc = await h.cashflow.build({ workspaceId: seed.workspaceId, period, accountId: acc, mode: 'byAccount' });
    const ap = byAcc.series.find((s) => s.accountId === acc)!.points.find((p) => p.label === '2025-06')!;
    expect(ap.outflow).toBe('0.00'); // и по одному счёту COGS не отток
  });

  it('byAccount: ноги перевода видны как движения между счетами', async () => {
    const from = await makeAccount({ name: 'Источник', openingBalance: '0' });
    const to = await makeAccount({ name: 'Получатель', openingBalance: '0' });
    await h.transfer.create(seed.workspaceId, seed.userId, {
      fromAccountId: from,
      toAccountId: to,
      amount: '2000',
      fee: '0',
      date: d2025(5).toISOString(),
    });

    const period: Period = { from: new Date(2025, 5, 1), to: new Date(2025, 5, 30, 23, 59, 59) };
    const report = await h.cashflow.build({
      workspaceId: seed.workspaceId,
      period,
      accountId: null,
      mode: 'byAccount',
    });
    // Серия на каждый счёт (включая seed CASH). Найдём from/to по имени.
    const fromS = report.series.find((s) => s.accountName === 'Источник')!;
    const toS = report.series.find((s) => s.accountName === 'Получатель')!;
    const jun = (s: typeof fromS) => s.points.find((p) => p.label === '2025-06')!;
    // У источника нога OUT — отток; у получателя нога IN — приток.
    expect(jun(fromS).outflow).toBe('2000.00');
    expect(jun(fromS).inflow).toBe('0.00');
    expect(jun(toS).inflow).toBe('2000.00');
    expect(jun(toS).outflow).toBe('0.00');
  });

  it('accountId задан → режим одного счёта (mode игнорируется), running balance с pre-period', async () => {
    const acc = await makeAccount({ name: 'Рабочий', openingBalance: '500' });
    // Транзакция ДО периода: должна попасть в openingForSeries, не в слайсы.
    await tx({ amount: '300', type: 'INCOME', kind: 'ORDER_PAYMENT', date: d2025(0), accountId: acc }); // январь
    // Транзакции внутри периода (июль).
    await tx({ amount: '1000', type: 'INCOME', kind: 'ORDER_PAYMENT', date: d2025(6), accountId: acc });
    await tx({ amount: '200', type: 'EXPENSE', kind: 'FIXED_COST', date: d2025(6), accountId: acc });
    // Транзакция на ДРУГОМ счёте — не должна влиять.
    await tx({ amount: '9999', type: 'INCOME', kind: 'ORDER_PAYMENT', date: d2025(6) });

    const period: Period = { from: new Date(2025, 6, 1), to: new Date(2025, 6, 31, 23, 59, 59) };
    const report = await h.cashflow.build({
      workspaceId: seed.workspaceId,
      period,
      accountId: acc,
      mode: 'consolidated', // должно игнорироваться при заданном accountId
    });
    expect(report.series).toHaveLength(1);
    const s = report.series[0]!;
    expect(s.accountId).toBe(acc);
    // openingForSeries = opening(500) + pre-period доход(300) = 800.
    expect(s.openingBalance).toBe('800.00');
    const jul = s.points.find((p) => p.label === '2025-07')!;
    expect(jul.inflow).toBe('1000.00'); // чужой счёт исключён
    expect(jul.outflow).toBe('200.00');
    expect(jul.net).toBe('800.00');
    expect(jul.balance).toBe('1600.00'); // 800 + 800
  });

  it('несуществующий accountId → пустой series', async () => {
    const report = await h.cashflow.build({
      workspaceId: seed.workspaceId,
      period: Y2025,
      accountId: 'no-such-account',
      mode: 'byAccount',
    });
    expect(report.series).toHaveLength(0);
  });
});

// ───────────────────────── Breakdown by category ─────────────────────────

describe('Breakdown by-category (по данным)', () => {
  it('type=ALL: доход и расход по категориям, доли, null → «Без категории», сортировка', async () => {
    const sales = await makeCategory('Продажи', 'INCOME', 'REVENUE');
    const rent = await makeCategory('Аренда', 'EXPENSE', 'FIXED');
    await tx({ amount: '6000', type: 'INCOME', kind: 'ORDER_PAYMENT', date: d2025(2), categoryId: sales });
    await tx({ amount: '2000', type: 'EXPENSE', kind: 'FIXED_COST', date: d2025(2), categoryId: rent });
    await tx({ amount: '2000', type: 'EXPENSE', kind: 'OTHER', date: d2025(2), categoryId: null }); // без категории

    const report = await breakdown.byCategory({ workspaceId: seed.workspaceId, period: Y2025, type: 'ALL' });
    expect(report.totalIncome).toBe('6000.00');
    expect(report.totalExpense).toBe('4000.00');
    // denom (ALL) = income + expense = 10000.
    const salesRow = report.rows.find((r) => r.name === 'Продажи')!;
    expect(salesRow.total).toBe('6000.00');
    expect(salesRow.share).toBeCloseTo(0.6, 5);
    expect(salesRow.count).toBe(1);
    // null → «Без категории».
    const noneRow = report.rows.find((r) => r.id === null)!;
    expect(noneRow.name).toBe('Без категории');
    expect(noneRow.expense).toBe('2000.00');
    // Сортировка по убыванию total: первой идёт самая крупная (Продажи 6000).
    expect(report.rows[0]!.name).toBe('Продажи');
  });

  it('type=INCOME показывает только доход, denom = totalIncome', async () => {
    const a = await makeCategory('A', 'INCOME', 'REVENUE');
    const b = await makeCategory('B', 'INCOME', 'REVENUE');
    await tx({ amount: '3000', type: 'INCOME', kind: 'ORDER_PAYMENT', date: d2025(1), categoryId: a });
    await tx({ amount: '1000', type: 'INCOME', kind: 'ORDER_PAYMENT', date: d2025(1), categoryId: b });
    await tx({ amount: '5000', type: 'EXPENSE', kind: 'FIXED_COST', date: d2025(1) }); // не должно попасть

    const report = await breakdown.byCategory({ workspaceId: seed.workspaceId, period: Y2025, type: 'INCOME' });
    expect(report.rows).toHaveLength(2);
    const rowA = report.rows.find((r) => r.name === 'A')!;
    expect(rowA.total).toBe('3000.00');
    expect(rowA.share).toBeCloseTo(0.75, 5); // 3000 / 4000
  });

  it('share=0 когда нет транзакций (denom=0)', async () => {
    const report = await breakdown.byCategory({ workspaceId: seed.workspaceId, period: Y2025, type: 'EXPENSE' });
    expect(report.rows).toHaveLength(0);
    expect(report.totalExpense).toBe('0.00');
  });
});

// ───────────────────────── Breakdown by counterparty ─────────────────────────

describe('Breakdown by-counterparty (по данным)', () => {
  it('группирует по контрагенту, null → «Без контрагента», count и доля корректны', async () => {
    const client = await makeCounterparty('ООО Ромашка', 'CLIENT');
    const supplier = await makeCounterparty('Поставщик-1', 'SUPPLIER');
    await tx({ amount: '7000', type: 'INCOME', kind: 'ORDER_PAYMENT', date: d2025(8), counterpartyId: client });
    await tx({ amount: '1000', type: 'INCOME', kind: 'ORDER_PAYMENT', date: d2025(8), counterpartyId: client }); // второй платёж
    await tx({ amount: '4000', type: 'EXPENSE', kind: 'PURCHASE', date: d2025(8), counterpartyId: supplier });
    await tx({ amount: '500', type: 'EXPENSE', kind: 'OTHER', date: d2025(8), counterpartyId: null });

    const report = await breakdown.byCounterparty({ workspaceId: seed.workspaceId, period: Y2025, type: 'ALL' });
    const clientRow = report.rows.find((r) => r.name === 'ООО Ромашка')!;
    expect(clientRow.income).toBe('8000.00'); // 7000 + 1000
    expect(clientRow.count).toBe(2); // два платежа
    const supRow = report.rows.find((r) => r.name === 'Поставщик-1')!;
    expect(supRow.expense).toBe('4000.00');
    const noneRow = report.rows.find((r) => r.id === null)!;
    expect(noneRow.name).toBe('Без контрагента');
    // Сортировка: самый крупный оборот (клиент 8000) первым.
    expect(report.rows[0]!.name).toBe('ООО Ромашка');
  });

  it('type=EXPENSE фильтрует только расход', async () => {
    const sup = await makeCounterparty('Поставщик', 'SUPPLIER');
    await tx({ amount: '1000', type: 'INCOME', kind: 'ORDER_PAYMENT', date: d2025(2), counterpartyId: sup });
    await tx({ amount: '600', type: 'EXPENSE', kind: 'PURCHASE', date: d2025(2), counterpartyId: sup });

    const report = await breakdown.byCounterparty({ workspaceId: seed.workspaceId, period: Y2025, type: 'EXPENSE' });
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]!.total).toBe('600.00');
    expect(report.rows[0]!.share).toBeCloseTo(1, 5); // единственный расход
  });
});

// ───────────────────────── Export CSV/XLSX ─────────────────────────

describe('Экспорт отчёта в CSV/XLSX', () => {
  it('P&L → CSV содержит суммы и заголовок; имя расширение csv', async () => {
    const revCat = await makeCategory('Продажи', 'INCOME', 'REVENUE');
    await tx({ amount: '12345.67', type: 'INCOME', kind: 'ORDER_PAYMENT', date: d2025(2), categoryId: revCat });
    const report = await h.pnl.build({
      workspaceId: seed.workspaceId,
      primary: Y2025,
      comparison: null,
      groupBy: 'month',
    });
    const table = pnlToTable(report);
    const file = await renderReport(table, 'csv');
    expect(file.extension).toBe('csv');
    expect(file.mimeType).toContain('text/csv');
    const text = file.buffer.toString('utf-8');
    expect(text).toContain('Прибыль и убытки');
    // ru-RU money формат использует запятую как десятичный разделитель (12 345,67).
    expect(text).toContain(',67');
  });

  it('Cashflow → XLSX возвращает непустой буфер с zip-сигнатурой', async () => {
    await tx({ amount: '1000', type: 'INCOME', kind: 'ORDER_PAYMENT', date: d2025(2) });
    const report = await h.cashflow.build({
      workspaceId: seed.workspaceId,
      period: Y2025,
      accountId: null,
      mode: 'consolidated',
    });
    const table = cashflowToTable(report);
    const file = await renderReport(table, 'xlsx');
    expect(file.extension).toBe('xlsx');
    expect(file.buffer.length).toBeGreaterThan(0);
    // XLSX = zip → первые два байта 'PK'.
    expect(file.buffer.subarray(0, 2).toString('latin1')).toBe('PK');
  });

  it('by-category → CSV: subtitle и доля в процентах', async () => {
    const sales = await makeCategory('Продажи', 'INCOME', 'REVENUE');
    await tx({ amount: '1000', type: 'INCOME', kind: 'ORDER_PAYMENT', date: d2025(2), categoryId: sales });
    const report = await breakdown.byCategory({ workspaceId: seed.workspaceId, period: Y2025, type: 'INCOME' });
    const table = breakdownToTable(report, 'category');
    const file = await renderReport(table, 'csv');
    const text = file.buffer.toString('utf-8');
    expect(text).toContain('Отчёт по категориям');
    expect(text).toContain('Только доход');
    // Единственная категория = 100% оборота.
    expect(text).toContain('100.0%');
  });
});
