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
import { resolvePeriod, type Period } from './period';
import { Prisma } from '@prisma/client';
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

/** Период «весь 2025-й год» в UTC+5 (R5) — TZ-устойчиво через resolvePeriod, иначе
 *  локальные даты на CI(UTC) уехали бы за границу и дали 13 слайсов вместо 12. */
const Y2025: Period = resolvePeriod({ from: '2025-01-01', to: '2025-12-31' });

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

/** DONE-заказ прямой вставкой — признание IJ9 (closedAt, totalAmount, позиция qty=1). */
let ordSeq = 0;
async function doneOrder(opts: {
  closedAt: Date;
  total: string;
  /** СУММАРНАЯ себестоимость позиции (за все qty). */
  cogs?: string;
  discount?: string;
  qty?: string;
}): Promise<string> {
  ordSeq += 1;
  const discount = opts.discount ?? '0';
  const qty = new Prisma.Decimal(opts.qty ?? '1');
  const subtotal = new Prisma.Decimal(opts.total).plus(discount);
  const o = await h.prisma.order.create({
    data: {
      workspaceId: seed.workspaceId,
      number: `ORD-IJ9-${ordSeq}`,
      status: 'DONE',
      closedAt: opts.closedAt,
      subtotal: subtotal.toFixed(2),
      discountAmount: discount,
      totalAmount: opts.total,
      items: {
        create: [
          {
            name: `Позиция ${ordSeq}`,
            qty: qty.toFixed(3),
            unitPrice: subtotal.div(qty).toFixed(2),
            lineTotal: subtotal.toFixed(2),
            unitCostAtSale: opts.cogs ? new Prisma.Decimal(opts.cogs).div(qty).toFixed(4) : null,
          },
        ],
      },
    },
  });
  return o.id;
}

/** Событие возврата (OrderReturn, И1) прямой вставкой — минус месяца возврата. */
async function returnEvent(
  orderId: string,
  opts: { date: Date; revenue: string; cost?: string; qty?: string },
): Promise<void> {
  const item = await h.prisma.orderItem.findFirstOrThrow({ where: { orderId } });
  await h.prisma.orderReturn.create({
    data: {
      workspaceId: seed.workspaceId,
      orderId,
      orderItemId: item.id,
      qty: opts.qty ?? '1',
      revenueAmount: opts.revenue,
      costAmount: opts.cost ?? '0',
      refundAmount: '0',
      date: opts.date,
      createdById: seed.userId,
    },
  });
  // Как в реальном returnItem: событие идёт рука об руку с инкрементом кэша.
  await h.prisma.orderItem.update({
    where: { id: item.id },
    data: { returnedQty: new Prisma.Decimal(item.returnedQty).plus(opts.qty ?? '1').toFixed(3) },
  });
}

const bucketOf = (
  totals: { byBucket: { bucket: string; expense: string; income: string }[] },
  b: string,
) => totals.byBucket.find((x) => x.bucket === b)!;

// ───────────────────────── P&L ─────────────────────────

describe('P&L отчёт (по данным)', () => {
  it('доход/расход по бакетам, grossProfit = выручка − COGS, ноги перевода исключены ПО kind', async () => {
    const fixedCat = await makeCategory('Аренда', 'EXPENSE', 'FIXED');
    const varCat = await makeCategory('Комиссия', 'EXPENSE', 'VARIABLE');
    const otherAcc = await makeAccount({ name: 'Запасной' });

    // IJ9: выручка 10000 и COGS 3000 — признание DONE-заказа по closedAt
    // (не проводки); аренда 2000 (FIXED) — операцией.
    await doneOrder({ closedAt: d2025(2), total: '10000', cogs: '3000' });
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

  it('IJ3: CAPITAL исключён из headline Доход/Расход, net и grossProfit (виден только в bucket)', async () => {
    const capInCat = await makeCategory('Вложение', 'INCOME', 'CAPITAL');
    const capOutCat = await makeCategory('Изъятие', 'EXPENSE', 'CAPITAL');

    await doneOrder({ closedAt: d2025(4), total: '8000' });
    await tx({ amount: '20000', type: 'INCOME', kind: 'CAPITAL_IN', date: d2025(4), categoryId: capInCat });
    await tx({ amount: '5000', type: 'EXPENSE', kind: 'CAPITAL_OUT', date: d2025(4), categoryId: capOutCat });

    const report = await h.pnl.build({
      workspaceId: seed.workspaceId,
      primary: Y2025,
      comparison: null,
      groupBy: 'month',
    });
    const t = report.primary.totals;

    // IJ3: headline Доход/Расход БЕЗ CAPITAL → Доход − Расход === net тождественно.
    expect(t.income).toBe('8000.00'); // только операционный доход
    expect(t.expense).toBe('0.00'); // CAPITAL_OUT исключён
    expect(t.grossProfit).toBe('8000.00'); // выручка(8000) − COGS(0)
    expect(t.net).toBe('8000.00');
    // Проверка тождества Доход − Расход = net.
    expect(Number(t.income) - Number(t.expense)).toBe(Number(t.net));
    // CAPITAL по-прежнему виден в разбивке по бакетам.
    expect(bucketOf(t, 'CAPITAL').income).toBe('20000.00');
    expect(bucketOf(t, 'CAPITAL').expense).toBe('5000.00');
  });

  it('IJ2: grossProfit = чистая выручка − COGS (возврат поставщику не выручка, возврат клиенту вычтен)', async () => {
    // IJ9: признание 10000/COGS 3000 (5 шт по 2000/600), возврат клиентом
    // 1 шт (событие: −2000 выручки, −600 COGS), возврат поставщику 1500
    // (SUPPLIER_REFUND → PURCHASES, вне net).
    const orderId = await doneOrder({ closedAt: d2025(4), total: '10000', cogs: '3000', qty: '5' });
    await returnEvent(orderId, { date: d2025(4), revenue: '2000', cost: '600' });
    await tx({ amount: '1500', type: 'INCOME', kind: 'SUPPLIER_REFUND', date: d2025(4) });

    const report = await h.pnl.build({
      workspaceId: seed.workspaceId,
      primary: Y2025,
      comparison: null,
      groupBy: 'month',
    });
    const t = report.primary.totals;
    // grossProfit = (10000 − 2000) − (3000 − 600) = 5600: возврат минусует
    // и выручку, и себестоимость возвращённой единицы.
    expect(t.grossProfit).toBe('5600.00');
  });

  it('IJ9: WRITE_OFF — расход периода (склад = актив), PURCHASES — инфо вне итога', async () => {
    // Признание 10000; потеря склада WRITE_OFF 1500; закупка PURCHASE 7000.
    await doneOrder({ closedAt: d2025(4), total: '10000' });
    await tx({ amount: '1500', type: 'EXPENSE', kind: 'WRITE_OFF', date: d2025(4) });
    await tx({ amount: '7000', type: 'EXPENSE', kind: 'PURCHASE', date: d2025(4) });

    const report = await h.pnl.build({
      workspaceId: seed.workspaceId,
      primary: Y2025,
      comparison: null,
      groupBy: 'month',
    });
    const t = report.primary.totals;
    // Пересмотр F5 при IJ9 (решение №5): закупка склада больше не расход ОПиУ
    // (актив, инфо-строка) → списание запасов бьёт прибыль периода.
    expect(t.expense).toBe('1500.00');
    expect(t.net).toBe('8500.00');
    expect(t.grossProfit).toBe('8500.00'); // потеря в бакете COGS
    expect(Number(t.income) - Number(t.expense)).toBe(Number(t.net));
    // Закупки видны информационно в byBucket, но не в headline/net.
    expect(bucketOf(t, 'PURCHASES').expense).toBe('7000.00');
  });

  it('IJ9: признание по closedAt, а не по датам платежей (авансы не доход)', async () => {
    // Деньги пришли в июне (ORDER_PAYMENT), заказ закрыт в июле → выручка июля.
    await tx({ amount: '5000', type: 'INCOME', kind: 'ORDER_PAYMENT', date: d2025(5) });
    await doneOrder({ closedAt: d2025(6), total: '5000' });

    const report = await h.pnl.build({
      workspaceId: seed.workspaceId,
      primary: Y2025,
      comparison: null,
      groupBy: 'month',
    });
    expect(report.primary.buckets[5]!.income).toBe('0.00'); // июнь: аванс не доход
    expect(report.primary.buckets[6]!.income).toBe('5000.00'); // июль: реализация
    expect(report.primary.totals.income).toBe('5000.00');
  });

  it('IJ9: возврат минусует выручку и COGS в СВОЙ месяц, признание не трогает', async () => {
    // Май: 4 шт по 2500/1000. Июль: возврат 1 шт (−2500 выручки, −1000 COGS).
    const orderId = await doneOrder({ closedAt: d2025(4), total: '10000', cogs: '4000', qty: '4' });
    await returnEvent(orderId, { date: d2025(6), revenue: '2500', cost: '1000' });

    const report = await h.pnl.build({
      workspaceId: seed.workspaceId,
      primary: Y2025,
      comparison: null,
      groupBy: 'month',
    });
    const may = report.primary.buckets[4]!;
    expect(may.grossProfit).toBe('6000.00'); // 10000 − 4000, без ретро-правок
    const jul = report.primary.buckets[6]!;
    expect(bucketOf(jul, 'REVENUE').expense).toBe('2500.00');
    expect(bucketOf(jul, 'COGS').expense).toBe('-1000.00');
    expect(jul.grossProfit).toBe('-1500.00'); // −2500 − (−1000)
    // Итог года: (10000−2500) − (4000−1000) = 4500.
    expect(report.primary.totals.grossProfit).toBe('4500.00');
  });

  it('IJ9: скидка заказа уменьшает признание (выручка = totalAmount)', async () => {
    await doneOrder({ closedAt: d2025(4), total: '9000', discount: '1000', cogs: '3000' });
    const report = await h.pnl.build({
      workspaceId: seed.workspaceId,
      primary: Y2025,
      comparison: null,
      groupBy: 'month',
    });
    expect(report.primary.totals.income).toBe('9000.00');
    expect(report.primary.totals.grossProfit).toBe('6000.00');
  });

  it('IJ6: primary и comparison — хронологические равные массивы бакетов (совмещение по индексу позиционно)', async () => {
    const revCat = await makeCategory('Продажи', 'INCOME', 'REVENUE');
    // Primary: май+июнь; comparison: март+апрель (предыдущие 2 месяца).
    await tx({ amount: '1000', type: 'INCOME', kind: 'OTHER', date: d2025(4), categoryId: revCat }); // май
    await tx({ amount: '2000', type: 'INCOME', kind: 'OTHER', date: d2025(5), categoryId: revCat }); // июнь
    await tx({ amount: '100', type: 'INCOME', kind: 'OTHER', date: d2025(2), categoryId: revCat }); // март
    await tx({ amount: '200', type: 'INCOME', kind: 'OTHER', date: d2025(3), categoryId: revCat }); // апрель

    const report = await h.pnl.build({
      workspaceId: seed.workspaceId,
      primary: resolvePeriod({ from: '2025-05-01', to: '2025-06-30' }),
      comparison: resolvePeriod({ from: '2025-03-01', to: '2025-04-30' }),
      groupBy: 'month',
    });
    // Оба массива — 2 слайса в хронологическом порядке, равной длины.
    expect(report.primary.buckets.map((b) => b.label)).toEqual(['2025-05', '2025-06']);
    expect(report.comparison!.buckets.map((b) => b.label)).toEqual(['2025-03', '2025-04']);
    expect(report.primary.buckets.length).toBe(report.comparison!.buckets.length);
    // Совмещение по индексу = позиционное (1-й месяц периода ↔ 1-й месяц сравнения):
    // index 0: май(1000) ↔ март(100); index 1: июнь(2000) ↔ апрель(200).
    expect(report.primary.buckets[0]!.income).toBe('1000.00');
    expect(report.comparison!.buckets[0]!.income).toBe('100.00');
    expect(report.primary.buckets[1]!.income).toBe('2000.00');
    expect(report.comparison!.buckets[1]!.income).toBe('200.00');
  });

  it('groupBy=month режет на месячные слайсы; groupBy=quarter — на квартальные', async () => {
    const revCat = await makeCategory('Продажи', 'INCOME', 'REVENUE');
    await tx({ amount: '1000', type: 'INCOME', kind: 'OTHER', date: d2025(0), categoryId: revCat }); // Q1
    await tx({ amount: '2000', type: 'INCOME', kind: 'OTHER', date: d2025(3), categoryId: revCat }); // Q2

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

  it('TZ-граница (+5): доход на стыке месяцев бакетится по поясу бизнеса', async () => {
    const revCat = await makeCategory('Продажи', 'INCOME', 'REVENUE');
    // 2025-03-31T20:00Z = 2025-04-01 01:00 +5 → апрель (Q2), не март (Q1).
    await tx({
      amount: '900',
      type: 'INCOME',
      kind: 'OTHER',
      date: new Date('2025-03-31T20:00:00Z'),
      categoryId: revCat,
    });
    const byMonth = await h.pnl.build({
      workspaceId: seed.workspaceId,
      primary: Y2025,
      comparison: null,
      groupBy: 'month',
    });
    expect(byMonth.primary.buckets[2]!.label).toBe('2025-03');
    expect(byMonth.primary.buckets[2]!.income).toBe('0.00'); // март пуст
    expect(byMonth.primary.buckets[3]!.label).toBe('2025-04');
    expect(byMonth.primary.buckets[3]!.income).toBe('900.00'); // ушло в апрель по +5
  });

  it('режим сравнения возвращает данные периода comparison', async () => {
    const revCat = await makeCategory('Продажи', 'INCOME', 'REVENUE');
    await tx({ amount: '5000', type: 'INCOME', kind: 'OTHER', date: d2025(6), categoryId: revCat }); // primary
    await tx({ amount: '3000', type: 'INCOME', kind: 'OTHER', date: new Date(2024, 6, 15), categoryId: revCat }); // yoy

    const primary: Period = { from: new Date(2025, 0, 1), to: new Date(2025, 11, 31, 23, 59, 59) };
    const comparison: Period = { from: new Date(2024, 0, 1), to: new Date(2024, 11, 31, 23, 59, 59) };

    const report = await h.pnl.build({ workspaceId: seed.workspaceId, primary, comparison, groupBy: 'month' });
    expect(report.primary.totals.income).toBe('5000.00');
    expect(report.comparison).not.toBeNull();
    expect(report.comparison!.totals.income).toBe('3000.00');
  });

  it('IJ9: сверка с отчётом маржи — grossProfit ОПиУ == маржа (без возвратов)', async () => {
    await doneOrder({ closedAt: d2025(3), total: '10000', cogs: '4000' });
    await doneOrder({ closedAt: d2025(5), total: '6000', discount: '500', cogs: '2000' });

    const pnl = await h.pnl.build({
      workspaceId: seed.workspaceId,
      primary: Y2025,
      comparison: null,
      groupBy: 'month',
    });
    // byClient — единственный разрез маржи, вычитающий скидку заказа (IJ1;
    // by-product не может отнести order-level скидку к товару).
    const margin = await h.tradeMargin.byClient(seed.workspaceId, Y2025);
    // Единый базис closedAt: (10000−4000) + (6000−2000) = 10000 в обоих отчётах.
    expect(pnl.primary.totals.grossProfit).toBe('10000.00');
    expect(margin.totals.margin).toBe(pnl.primary.totals.grossProfit);
  });

  it('IJ9-И3: сверка ОПиУ ↔ маржа ПРИ возврате через границу месяца', async () => {
    // Май: 4 шт по 2500 (себест. 1000/шт). Июль: возврат 1 шт.
    const orderId = await doneOrder({ closedAt: d2025(4), total: '10000', cogs: '4000', qty: '4' });
    await returnEvent(orderId, { date: d2025(6), revenue: '2500', cost: '1000' });

    const pnl = await h.pnl.build({
      workspaceId: seed.workspaceId,
      primary: Y2025,
      comparison: null,
      groupBy: 'month',
    });
    const marginYear = await h.tradeMargin.byProduct(seed.workspaceId, Y2025);
    // Год: (10000−2500) − (4000−1000) = 4500 в обоих отчётах.
    expect(pnl.primary.totals.grossProfit).toBe('4500.00');
    expect(marginYear.totals.margin).toBe('4500.00');

    // Июль изолированно: маржа видит ТОЛЬКО минус возврата (−2500 + 1000 = −1500),
    // как июльский grossProfit ОПиУ.
    const july = resolvePeriod({ from: '2025-07-01', to: '2025-07-31' });
    const marginJuly = await h.tradeMargin.byProduct(seed.workspaceId, july);
    expect(marginJuly.totals.margin).toBe('-1500.00');
    expect(pnl.primary.buckets[6]!.grossProfit).toBe('-1500.00');

    // Май изолированно: полное признание без ретро-правок.
    const may = resolvePeriod({ from: '2025-05-01', to: '2025-05-31' });
    const marginMay = await h.tradeMargin.byProduct(seed.workspaceId, may);
    expect(marginMay.totals.margin).toBe('6000.00');
    expect(pnl.primary.buckets[4]!.grossProfit).toBe('6000.00');
  });

  it('byCategory сортируется по убыванию суммарного оборота', async () => {
    const big = await makeCategory('Крупная', 'INCOME', 'REVENUE');
    const small = await makeCategory('Мелкая', 'INCOME', 'REVENUE');
    await tx({ amount: '100', type: 'INCOME', kind: 'OTHER', date: d2025(1), categoryId: small });
    await tx({ amount: '900', type: 'INCOME', kind: 'OTHER', date: d2025(1), categoryId: big });

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

  it('TZ-граница (+5): операция в конце месяца по UTC бакетится по поясу бизнеса', async () => {
    // 2025-01-31T21:00Z = 2025-02-01 02:00 в UTC+5 → должна попасть в ФЕВРАЛЬ
    // (date_trunc в SQL делает сдвиг +5, как enumerateMonths). Без сдвига уехала
    // бы в январь. Контроль: операция явно в январе по +5.
    const acc = await makeAccount({ name: 'Касса tz', openingBalance: '0' });
    await tx({
      amount: '700',
      type: 'INCOME',
      kind: 'ORDER_PAYMENT',
      date: new Date('2025-01-31T21:00:00Z'),
      accountId: acc,
    });
    await tx({
      amount: '300',
      type: 'INCOME',
      kind: 'ORDER_PAYMENT',
      date: new Date('2025-01-15T05:00:00Z'), // 2025-01-15 10:00 +5 → январь
      accountId: acc,
    });

    const report = await h.cashflow.build({
      workspaceId: seed.workspaceId,
      period: Y2025,
      accountId: acc,
      mode: 'byAccount',
    });
    const s = report.series[0]!;
    const jan = s.points.find((p) => p.label === '2025-01')!;
    const feb = s.points.find((p) => p.label === '2025-02')!;
    expect(jan.inflow).toBe('300.00'); // только явно-январская
    expect(feb.inflow).toBe('700.00'); // граничная ушла в февраль по +5
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

  it('неденежный COGS исключён из разреза by-category (не раздувает «Без категории»)', async () => {
    const rent = await makeCategory('Аренда', 'EXPENSE', 'FIXED');
    await tx({ amount: '2000', type: 'EXPENSE', kind: 'FIXED_COST', date: d2025(2), categoryId: rent });
    // COGS — неденежный (R2), без категории. Не должен попасть в разрез расходов
    // (иначе сел бы в «Без категории» и расходился бы с P&L/cashflow).
    await tx({ amount: '1500', type: 'EXPENSE', kind: 'COGS', date: d2025(2), categoryId: null });

    const report = await breakdown.byCategory({ workspaceId: seed.workspaceId, period: Y2025, type: 'EXPENSE' });
    expect(report.totalExpense).toBe('2000.00'); // только аренда, без COGS
    expect(report.rows.find((r) => r.id === null)).toBeUndefined(); // нет строки «Без категории»
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
    await tx({ amount: '12345.67', type: 'INCOME', kind: 'OTHER', date: d2025(2), categoryId: revCat });
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
