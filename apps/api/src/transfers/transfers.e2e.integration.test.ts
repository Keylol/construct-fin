/**
 * E2E (DB-backed) интеграционные тесты домена «Переводы между счетами +
 * влияние на P&L/cashflow» против реальной БД (construct_v6_test).
 *
 * Augment к существующим unit-тестам (transfer.service.test.ts /
 * cashflow.service.test.ts / pnl.service.test.ts): здесь всё прогоняется по
 * ДАННЫМ — заводим счета/транзакции, выполняем сервис, проверяем эффект в БД
 * и в ответах отчётных сервисов (CashflowService/PnlService).
 *
 * Уникальный диапазон telegramId этого файла: 1200000n (tg += 1n в beforeEach).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  buildHarness,
  resetDb,
  seedBase,
  type Harness,
  type Seed,
} from '../test/money-harness';
import type { Period } from '../reports/period';

let h: Harness;
let seed: Seed;
let tg = 1200000n; // уникальный диапазон telegramId этого файла

const num = (v: { toString(): string }) => Number(v.toString());

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

/** Заводит второй счёт в workspace (seedBase создал только один — Каса/CASH). */
async function makeAccount(name: string, openingBalance = '0', type: 'CASH' | 'BANK' = 'BANK') {
  const acc = await h.prisma.account.create({
    data: { workspaceId: seed.workspaceId, name, type, openingBalance },
  });
  return acc.id;
}

/** Активные (не soft-deleted) транзакции workspace. */
function activeTx(extra: Record<string, unknown> = {}) {
  return h.prisma.transaction.findMany({
    where: { workspaceId: seed.workspaceId, deletedAt: null, ...extra },
    orderBy: { kind: 'asc' },
  });
}

// Период на весь 2026-й — все наши даты внутри одного месяца попадают в слайс.
const PERIOD_2026: Period = {
  from: new Date('2026-01-01T00:00:00.000Z'),
  to: new Date('2026-12-31T23:59:59.999Z'),
};
const DATE = '2026-06-10T12:00:00.000Z';

describe('Переводы — создание по данным (POST /transfers → TransferService.create)', () => {
  it('создаёт Transfer + 2 ноги (TRANSFER_OUT/IN) с общим transferGroupId, без fee', async () => {
    const from = seed.accountId;
    const to = await makeAccount('Эквайринг');

    const res = await h.transfer.create(seed.workspaceId, seed.userId, {
      fromAccountId: from,
      toAccountId: to,
      amount: '1000.00',
      fee: '0',
      date: DATE,
    });

    // Ответ сериализован в монетные строки.
    expect(res.amount).toBe('1000.00');
    expect(res.fee).toBe('0.00');
    expect(res.fromAccountId).toBe(from);
    expect(res.toAccountId).toBe(to);

    // В БД ровно 2 ноги, обе с transferGroupId = transfer.id.
    const legs = await activeTx();
    expect(legs).toHaveLength(2);
    const out = legs.find((t) => t.kind === 'TRANSFER_OUT')!;
    const inc = legs.find((t) => t.kind === 'TRANSFER_IN')!;
    expect(out.type).toBe('EXPENSE');
    expect(out.accountId).toBe(from);
    expect(num(out.amount)).toBe(1000);
    expect(out.transferGroupId).toBe(res.id);
    expect(inc.type).toBe('INCOME');
    expect(inc.accountId).toBe(to);
    expect(num(inc.amount)).toBe(1000);
    expect(inc.transferGroupId).toBe(res.id);
  });

  it('fee>0 добавляет 3-ю транзакцию VARIABLE_COST/EXPENSE на счёте-источнике с тем же transferGroupId', async () => {
    const from = seed.accountId;
    const to = await makeAccount('Банк 2');

    const res = await h.transfer.create(seed.workspaceId, seed.userId, {
      fromAccountId: from,
      toAccountId: to,
      amount: '5000.00',
      fee: '15.50',
      date: DATE,
      note: 'Инкассация',
    });
    expect(res.fee).toBe('15.50');

    const feeTx = await h.prisma.transaction.findFirstOrThrow({
      where: { workspaceId: seed.workspaceId, kind: 'VARIABLE_COST' },
    });
    expect(feeTx.type).toBe('EXPENSE');
    expect(feeTx.accountId).toBe(from); // комиссия списывается со счёта-источника
    expect(num(feeTx.amount)).toBe(15.5);
    expect(feeTx.transferGroupId).toBe(res.id); // привязана к группе → softDelete погасит каскадом
    expect(feeTx.description).toContain('Инкассация');

    // Всего 3 активных транзакции: OUT + IN + комиссия.
    const all = await activeTx();
    expect(all).toHaveLength(3);
  });

  it('сумма парсится в Decimal с точностью (центы не теряются)', async () => {
    const to = await makeAccount('Банк точн.');
    const res = await h.transfer.create(seed.workspaceId, seed.userId, {
      fromAccountId: seed.accountId,
      toAccountId: to,
      amount: '1234.57',
      fee: '0.03',
      date: DATE,
    });
    expect(res.amount).toBe('1234.57');
    const out = await h.prisma.transaction.findFirstOrThrow({
      where: { workspaceId: seed.workspaceId, kind: 'TRANSFER_OUT' },
    });
    expect(out.amount.toFixed(2)).toBe('1234.57');
    const fee = await h.prisma.transaction.findFirstOrThrow({
      where: { workspaceId: seed.workspaceId, kind: 'VARIABLE_COST' },
    });
    expect(fee.amount.toFixed(2)).toBe('0.03');
  });

  it('guard: amount ≤ 0 → BadRequestException, ничего не создаётся (атомарность)', async () => {
    const to = await makeAccount('Банк отказ');
    await expect(
      h.transfer.create(seed.workspaceId, seed.userId, {
        fromAccountId: seed.accountId,
        toAccountId: to,
        amount: '0',
        fee: '0',
        date: DATE,
      }),
    ).rejects.toThrow('amount должен быть положительным');

    expect(await activeTx()).toHaveLength(0);
    expect(await h.transfer.list(seed.workspaceId)).toHaveLength(0);
  });

  it('guard: fee < 0 → BadRequestException', async () => {
    const to = await makeAccount('Банк fee-');
    await expect(
      h.transfer.create(seed.workspaceId, seed.userId, {
        fromAccountId: seed.accountId,
        toAccountId: to,
        amount: '100.00',
        fee: '-1.00',
        date: DATE,
      }),
    ).rejects.toThrow('fee не может быть отрицательным');
    expect(await activeTx()).toHaveLength(0);
  });

  it('guard: fromAccount не в workspace → BadRequestException, ноги не создаются', async () => {
    const to = await makeAccount('Получатель');
    await expect(
      h.transfer.create(seed.workspaceId, seed.userId, {
        fromAccountId: 'ckxnonexistentaccount0001',
        toAccountId: to,
        amount: '100.00',
        fee: '0',
        date: DATE,
      }),
    ).rejects.toThrow('fromAccount not found in this workspace');
    expect(await activeTx()).toHaveLength(0);
  });

  it('guard: toAccount не в workspace → BadRequestException', async () => {
    await expect(
      h.transfer.create(seed.workspaceId, seed.userId, {
        fromAccountId: seed.accountId,
        toAccountId: 'ckxnonexistentaccount0002',
        amount: '100.00',
        fee: '0',
        date: DATE,
      }),
    ).rejects.toThrow('toAccount not found in this workspace');
    expect(await activeTx()).toHaveLength(0);
  });

  it('guard: счёт из чужого workspace не считается «своим» → BadRequest', async () => {
    // Заводим второй workspace с собственным счётом, пытаемся перевести туда.
    const otherUser = await h.prisma.user.create({
      data: { telegramId: tg + 500000n, username: 'other', firstName: 'Other' },
    });
    const otherWs = await h.prisma.workspace.create({
      data: { name: 'Чужой WS', ownerId: otherUser.id },
    });
    const foreignAcc = await h.prisma.account.create({
      data: { workspaceId: otherWs.id, name: 'Чужой счёт', type: 'CASH' },
    });

    await expect(
      h.transfer.create(seed.workspaceId, seed.userId, {
        fromAccountId: seed.accountId,
        toAccountId: foreignAcc.id,
        amount: '100.00',
        fee: '0',
        date: DATE,
      }),
    ).rejects.toThrow('toAccount not found in this workspace');
    expect(await activeTx()).toHaveLength(0);
  });
});

describe('Переводы — список (GET /transfers → TransferService.list)', () => {
  it('возвращает активные переводы, сортировка по date DESC, суммы в монетном формате', async () => {
    const to = await makeAccount('Банк список');
    await h.transfer.create(seed.workspaceId, seed.userId, {
      fromAccountId: seed.accountId,
      toAccountId: to,
      amount: '100.00',
      fee: '0',
      date: '2026-06-01T10:00:00.000Z',
      note: 'первый',
    });
    await h.transfer.create(seed.workspaceId, seed.userId, {
      fromAccountId: seed.accountId,
      toAccountId: to,
      amount: '250.00',
      fee: '5.00',
      date: '2026-06-20T10:00:00.000Z',
      note: 'второй',
    });

    const list = await h.transfer.list(seed.workspaceId);
    expect(list).toHaveLength(2);
    // date DESC → «второй» (20-е) первым.
    expect(list[0]!.note).toBe('второй');
    expect(list[0]!.amount).toBe('250.00');
    expect(list[0]!.fee).toBe('5.00');
    expect(list[1]!.note).toBe('первый');
    expect(list[1]!.amount).toBe('100.00');
    expect(list[1]!.fee).toBe('0.00');
  });

  it('пустой workspace → пустой массив', async () => {
    expect(await h.transfer.list(seed.workspaceId)).toEqual([]);
  });

  it('soft-deleted перевод не попадает в список', async () => {
    const to = await makeAccount('Банк del');
    const t = await h.transfer.create(seed.workspaceId, seed.userId, {
      fromAccountId: seed.accountId,
      toAccountId: to,
      amount: '300.00',
      fee: '0',
      date: DATE,
    });
    await h.transfer.softDelete(seed.workspaceId, t.id);
    expect(await h.transfer.list(seed.workspaceId)).toEqual([]);
  });
});

describe('Переводы — мягкое удаление (DELETE /transfers/:id → TransferService.softDelete)', () => {
  it('каскадно гасит Transfer + обе ноги + комиссию (deletedAt у всех)', async () => {
    const to = await makeAccount('Банк каскад');
    const t = await h.transfer.create(seed.workspaceId, seed.userId, {
      fromAccountId: seed.accountId,
      toAccountId: to,
      amount: '1000.00',
      fee: '20.00',
      date: DATE,
    });
    expect(await activeTx()).toHaveLength(3);

    await h.transfer.softDelete(seed.workspaceId, t.id);

    // Активных транзакций по группе не осталось.
    expect(await activeTx()).toHaveLength(0);
    // Но физически они есть — все 3 с проставленным deletedAt.
    const allByGroup = await h.prisma.transaction.findMany({
      where: { workspaceId: seed.workspaceId, transferGroupId: t.id },
    });
    expect(allByGroup).toHaveLength(3);
    expect(allByGroup.every((tx) => tx.deletedAt !== null)).toBe(true);

    const transferRow = await h.prisma.transfer.findUniqueOrThrow({ where: { id: t.id } });
    expect(transferRow.deletedAt).not.toBeNull();
  });

  it('guard: несуществующий id → NotFoundException', async () => {
    await expect(
      h.transfer.softDelete(seed.workspaceId, 'ckxnosuchtransfer00001'),
    ).rejects.toThrow('Transfer not found');
  });

  it('guard: повторный softDelete уже удалённого → NotFoundException', async () => {
    const to = await makeAccount('Банк 2x');
    const t = await h.transfer.create(seed.workspaceId, seed.userId, {
      fromAccountId: seed.accountId,
      toAccountId: to,
      amount: '50.00',
      fee: '0',
      date: DATE,
    });
    await h.transfer.softDelete(seed.workspaceId, t.id);
    await expect(h.transfer.softDelete(seed.workspaceId, t.id)).rejects.toThrow(
      'Transfer not found',
    );
  });
});

describe('Влияние на Cashflow (CashflowService.build)', () => {
  it('консолидация: внутренний перевод НЕ создаёт ни притока, ни оттока (ноги исключены по kind)', async () => {
    const from = seed.accountId; // CASH, opening 0
    const to = await makeAccount('Эквайринг', '0');
    await h.transfer.create(seed.workspaceId, seed.userId, {
      fromAccountId: from,
      toAccountId: to,
      amount: '1000.00',
      fee: '0',
      date: DATE,
    });

    const report = await h.cashflow.build({
      workspaceId: seed.workspaceId,
      period: PERIOD_2026,
      accountId: null,
      mode: 'consolidated',
    });
    expect(report.series).toHaveLength(1);
    const totals = report.series[0]!.points.reduce(
      (acc, p) => ({
        inflow: acc.inflow + num(p.inflow),
        outflow: acc.outflow + num(p.outflow),
      }),
      { inflow: 0, outflow: 0 },
    );
    // Ноги перевода исключены → нулевой оборот в консолидации.
    expect(totals.inflow).toBe(0);
    expect(totals.outflow).toBe(0);
  });

  it('консолидация: комиссия перевода (VARIABLE_COST) остаётся реальным оттоком', async () => {
    const to = await makeAccount('Банк ком.', '0');
    await h.transfer.create(seed.workspaceId, seed.userId, {
      fromAccountId: seed.accountId,
      toAccountId: to,
      amount: '1000.00',
      fee: '30.00',
      date: DATE,
    });

    const report = await h.cashflow.build({
      workspaceId: seed.workspaceId,
      period: PERIOD_2026,
      accountId: null,
      mode: 'consolidated',
    });
    const totalOut = report.series[0]!.points.reduce((a, p) => a + num(p.outflow), 0);
    const totalIn = report.series[0]!.points.reduce((a, p) => a + num(p.inflow), 0);
    expect(totalIn).toBe(0); // ноги исключены
    expect(totalOut).toBe(30); // осталась только комиссия
  });

  it('консолидация: opening пула = сумма openingBalance счетов; перевод не двигает конечный баланс (без fee)', async () => {
    const from = seed.accountId; // CASH opening 0
    const to = await makeAccount('Банк', '500.00');
    await h.transfer.create(seed.workspaceId, seed.userId, {
      fromAccountId: from,
      toAccountId: to,
      amount: '300.00',
      fee: '0',
      date: DATE,
    });
    const report = await h.cashflow.build({
      workspaceId: seed.workspaceId,
      period: PERIOD_2026,
      accountId: null,
      mode: 'consolidated',
    });
    expect(num(report.series[0]!.openingBalance)).toBe(500);
    const last = report.series[0]!.points[report.series[0]!.points.length - 1]!;
    // Без комиссии конечный баланс пула неизменен — перевод внутренний.
    expect(num(last.balance)).toBe(500);
  });

  it('по конкретному счёту: перевод виден как отток с источника и приток на получателя', async () => {
    const from = seed.accountId; // opening 0
    const to = await makeAccount('Эквайринг', '0');
    await h.transfer.create(seed.workspaceId, seed.userId, {
      fromAccountId: from,
      toAccountId: to,
      amount: '1000.00',
      fee: '40.00',
      date: DATE,
    });

    // Источник: видит ногу OUT (1000) + комиссию (40) → отток 1040.
    const fromReport = await h.cashflow.build({
      workspaceId: seed.workspaceId,
      period: PERIOD_2026,
      accountId: from,
    });
    expect(fromReport.series).toHaveLength(1);
    expect(fromReport.series[0]!.accountId).toBe(from);
    const fromOut = fromReport.series[0]!.points.reduce((a, p) => a + num(p.outflow), 0);
    const fromIn = fromReport.series[0]!.points.reduce((a, p) => a + num(p.inflow), 0);
    expect(fromOut).toBe(1040);
    expect(fromIn).toBe(0);

    // Получатель: видит ногу IN (1000) → приток 1000, оттока нет.
    const toReport = await h.cashflow.build({
      workspaceId: seed.workspaceId,
      period: PERIOD_2026,
      accountId: to,
    });
    const toOut = toReport.series[0]!.points.reduce((a, p) => a + num(p.outflow), 0);
    const toIn = toReport.series[0]!.points.reduce((a, p) => a + num(p.inflow), 0);
    expect(toIn).toBe(1000);
    expect(toOut).toBe(0);
  });

  it('по конкретному счёту: accountId задан → режим по счёту даже при mode=consolidated', async () => {
    const from = seed.accountId;
    const to = await makeAccount('Банк', '0');
    await h.transfer.create(seed.workspaceId, seed.userId, {
      fromAccountId: from,
      toAccountId: to,
      amount: '700.00',
      fee: '0',
      date: DATE,
    });
    const report = await h.cashflow.build({
      workspaceId: seed.workspaceId,
      period: PERIOD_2026,
      accountId: to,
      mode: 'consolidated', // должен быть проигнорирован в пользу счётного режима
    });
    expect(report.series).toHaveLength(1);
    expect(report.series[0]!.accountId).toBe(to);
    const inflow = report.series[0]!.points.reduce((a, p) => a + num(p.inflow), 0);
    expect(inflow).toBe(700); // нога IN видна
  });

  it('по несуществующему/удалённому счёту → пустая series (null отфильтрован)', async () => {
    const report = await h.cashflow.build({
      workspaceId: seed.workspaceId,
      period: PERIOD_2026,
      accountId: 'ckxnosuchacc000000001',
    });
    expect(report.series).toEqual([]);
  });

  it('byAccount без accountId: серия на каждый счёт, ноги переводов видны в обоих', async () => {
    const from = seed.accountId; // Каса
    const to = await makeAccount('Эквайринг', '0');
    await h.transfer.create(seed.workspaceId, seed.userId, {
      fromAccountId: from,
      toAccountId: to,
      amount: '900.00',
      fee: '0',
      date: DATE,
    });
    const report = await h.cashflow.build({
      workspaceId: seed.workspaceId,
      period: PERIOD_2026,
      accountId: null,
      mode: 'byAccount',
    });
    expect(report.series).toHaveLength(2);
    const fromSeries = report.series.find((s) => s.accountId === from)!;
    const toSeries = report.series.find((s) => s.accountId === to)!;
    const fromOut = fromSeries.points.reduce((a, p) => a + num(p.outflow), 0);
    const toIn = toSeries.points.reduce((a, p) => a + num(p.inflow), 0);
    expect(fromOut).toBe(900);
    expect(toIn).toBe(900);
  });

  it('после softDelete перевод исчезает из cashflow по счёту (ноги погашены)', async () => {
    const from = seed.accountId;
    const to = await makeAccount('Банк rev', '0');
    const t = await h.transfer.create(seed.workspaceId, seed.userId, {
      fromAccountId: from,
      toAccountId: to,
      amount: '1000.00',
      fee: '25.00',
      date: DATE,
    });
    await h.transfer.softDelete(seed.workspaceId, t.id);

    const fromReport = await h.cashflow.build({
      workspaceId: seed.workspaceId,
      period: PERIOD_2026,
      accountId: from,
    });
    const out = fromReport.series[0]!.points.reduce((a, p) => a + num(p.outflow), 0);
    expect(out).toBe(0); // и нога OUT, и комиссия погашены deletedAt
  });
});

describe('Влияние на P&L (PnlService.build)', () => {
  it('перевод без прочих операций даёт нулевой P&L (ноги исключены по kind)', async () => {
    const to = await makeAccount('Банк pnl0', '0');
    await h.transfer.create(seed.workspaceId, seed.userId, {
      fromAccountId: seed.accountId,
      toAccountId: to,
      amount: '5000.00',
      fee: '0',
      date: DATE,
    });

    const report = await h.pnl.build({
      workspaceId: seed.workspaceId,
      primary: PERIOD_2026,
      comparison: null,
      groupBy: 'month',
    });
    expect(num(report.primary.totals.income)).toBe(0);
    expect(num(report.primary.totals.expense)).toBe(0);
    expect(num(report.primary.totals.net)).toBe(0);
  });

  it('комиссия перевода (VARIABLE_COST) остаётся расходом и снижает чистую прибыль', async () => {
    // Заводим реальный доход, чтобы net был не нулевой и был «фон» для комиссии.
    const cat = await h.prisma.category.create({
      data: {
        workspaceId: seed.workspaceId,
        name: 'Выручка',
        kind: 'INCOME',
        bucket: 'REVENUE',
      },
    });
    await h.prisma.transaction.create({
      data: {
        workspaceId: seed.workspaceId,
        date: new Date(DATE),
        amount: '2000.00',
        type: 'INCOME',
        kind: 'OTHER',
        accountId: seed.accountId,
        categoryId: cat.id,
        createdById: seed.userId,
      },
    });

    const to = await makeAccount('Банк pnl-fee', '0');
    await h.transfer.create(seed.workspaceId, seed.userId, {
      fromAccountId: seed.accountId,
      toAccountId: to,
      amount: '1000.00',
      fee: '50.00',
      date: DATE,
    });

    const report = await h.pnl.build({
      workspaceId: seed.workspaceId,
      primary: PERIOD_2026,
      comparison: null,
      groupBy: 'month',
    });
    // Доход = 2000 (ноги исключены). Расход = 50 (только комиссия, ноги исключены).
    expect(num(report.primary.totals.income)).toBe(2000);
    expect(num(report.primary.totals.expense)).toBe(50);
    expect(num(report.primary.totals.net)).toBe(1950);
    // Комиссия перевода (kind=VARIABLE_COST) без categoryId → бакет VARIABLE
    // (Трек A A3: системные kind без категории бакетятся по kind). В OTHER пусто.
    const variable = report.primary.totals.byBucket.find((b) => b.bucket === 'VARIABLE')!;
    expect(num(variable.expense)).toBe(50);
    const other = report.primary.totals.byBucket.find((b) => b.bucket === 'OTHER')!;
    expect(num(other.expense)).toBe(0);
  });

  it('перевод не влияет на сравнение периодов: net обоих периодов = 0 при одних переводах', async () => {
    const to = await makeAccount('Банк pnl-cmp', '0');
    // Перевод в июне (primary) и в мае (comparison='prev').
    await h.transfer.create(seed.workspaceId, seed.userId, {
      fromAccountId: seed.accountId,
      toAccountId: to,
      amount: '800.00',
      fee: '0',
      date: '2026-06-10T12:00:00.000Z',
    });
    await h.transfer.create(seed.workspaceId, seed.userId, {
      fromAccountId: seed.accountId,
      toAccountId: to,
      amount: '900.00',
      fee: '0',
      date: '2026-05-10T12:00:00.000Z',
    });

    const june: Period = {
      from: new Date('2026-06-01T00:00:00.000Z'),
      to: new Date('2026-06-30T23:59:59.999Z'),
    };
    const may: Period = {
      from: new Date('2026-05-01T00:00:00.000Z'),
      to: new Date('2026-05-31T23:59:59.999Z'),
    };
    const report = await h.pnl.build({
      workspaceId: seed.workspaceId,
      primary: june,
      comparison: may,
      groupBy: 'month',
    });
    expect(num(report.primary.totals.net)).toBe(0);
    expect(report.comparison).not.toBeNull();
    expect(num(report.comparison!.totals.net)).toBe(0);
  });
});
