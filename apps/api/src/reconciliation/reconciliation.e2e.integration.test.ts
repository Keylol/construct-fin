/**
 * E2E (DB-backed) интеграционные тесты домена «Сверка счетов» (Полоса D) против
 * реальной БД construct_v6_test (:5433). НЕ запускать локально мимоходом — общая
 * БД, сериализованный прогон (см. CLAUDE.md / vitest.integration.config.ts).
 *
 * Augment к reconciliation.service.test.ts (там Prisma мокается). Здесь — живой
 * Prisma: заводим реальные Account/Transaction/AccountBalanceCheck и проверяем
 * эффект сверки в ответе сервиса / в БД. Покрываем 4 флоу карты:
 *   • build()       — отчёт сверки (нет снимков / снимок+несведённые / soft-delete
 *                     транзакций / asOf в будущем / Decimal-точность / гард 404).
 *   • createCheck() — ввод снимка (запись в БД, money()-округление, note-trim,
 *                     несколько снимков на разные даты, гард 404 на soft-deleted).
 *   • listChecks()  — история снимков (сортировка date desc / createdAt desc,
 *                     фильтр по счёту, гард 404, сериализация actualBalance).
 *   • deleteCheck() — физическое удаление снимка + пересчёт discrepancy после
 *                     удаления последнего снимка; гард 404 / изоляция workspace.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import {
  buildHarness,
  resetDb,
  seedBase,
  type Harness,
  type Seed,
} from '../test/money-harness';

let h: Harness;
let seed: Seed;
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
  seed = await seedBase(h.prisma, tg);
});

const num = (v: unknown) => Number((v as { toString(): string }).toString());

/** Создаёт транзакцию счёта (по умолчанию seed.accountId). */
async function makeTx(over: {
  type: 'INCOME' | 'EXPENSE';
  amount: string;
  date: string;
  kind?:
    | 'OTHER'
    | 'ORDER_PAYMENT'
    | 'PURCHASE'
    | 'SALARY'
    | 'TAX'
    | 'FIXED_COST'
    | 'TRANSFER_IN'
    | 'TRANSFER_OUT';
  accountId?: string;
  deletedAt?: Date | null;
  description?: string | null;
}) {
  return h.prisma.transaction.create({
    data: {
      workspaceId: seed.workspaceId,
      accountId: over.accountId ?? seed.accountId,
      date: new Date(over.date),
      amount: over.amount,
      type: over.type,
      kind: over.kind ?? 'OTHER',
      description: over.description ?? null,
      deletedAt: over.deletedAt ?? null,
      createdById: seed.userId,
    },
  });
}

/** Заводит второй счёт (например с ненулевым openingBalance). */
async function makeAccount(over: Record<string, unknown> = {}) {
  const acc = await h.prisma.account.create({
    data: { workspaceId: seed.workspaceId, name: 'Расчётный', type: 'BANK', ...over },
  });
  return acc.id;
}

// ───────────────────────── build(): отчёт сверки ─────────────────────────

describe('D-e2e build: отчёт сверки по данным', () => {
  it('нет снимков → lastCheck=null, since=null, computed = opening + INCOME − EXPENSE', async () => {
    // openingBalance счёта seed = 0 по умолчанию (seedBase). Заведём отдельный
    // счёт с ненулевым opening, чтобы проверить вклад opening в книгу.
    const accId = await makeAccount({ openingBalance: '1000.00' });
    await makeTx({ type: 'INCOME', amount: '500.00', date: '2026-06-05T00:00:00.000Z', accountId: accId });
    await makeTx({ type: 'EXPENSE', amount: '200.00', date: '2026-06-08T00:00:00.000Z', accountId: accId });

    const r = await h.reconciliation.build(seed.workspaceId, accId, '2026-06-15T00:00:00.000Z');

    expect(r.openingBalance).toBe('1000.00');
    // 1000 + 500 − 200 = 1300
    expect(num(r.computedBalance)).toBe(1300);
    expect(r.lastCheck).toBeNull();
    expect(r.unreconciled.since).toBeNull();
    expect(r.unreconciled.count).toBe(2);
    // net несведённых = +500 − 200 = +300
    expect(num(r.unreconciled.net)).toBe(300);
    expect(r.accountName).toBe('Расчётный');
  });

  it('со снимком: discrepancy = факт − книга на дату снимка; несведённые ТОЛЬКО после снимка', async () => {
    const accId = await makeAccount({ openingBalance: '1000.00' });
    // до снимка
    await makeTx({ type: 'INCOME', amount: '500.00', date: '2026-06-05T00:00:00.000Z', accountId: accId });
    // после снимка
    await makeTx({ type: 'EXPENSE', amount: '200.00', date: '2026-06-12T00:00:00.000Z', accountId: accId });

    // факт-снимок на 2026-06-08: книга на эту дату = 1000 + 500 = 1500
    await h.reconciliation.createCheck(seed.workspaceId, seed.userId, {
      accountId: accId,
      date: '2026-06-08T00:00:00.000Z',
      actualBalance: '1450.00',
    });

    const r = await h.reconciliation.build(seed.workspaceId, accId, '2026-06-15T00:00:00.000Z');

    // книга на asOf = 1000 + 500 − 200 = 1300
    expect(num(r.computedBalance)).toBe(1300);
    expect(r.lastCheck).not.toBeNull();
    expect(num(r.lastCheck!.computedBalance)).toBe(1500);
    expect(num(r.lastCheck!.actualBalance)).toBe(1450);
    // discrepancy = 1450 − 1500 = −50 (книга завышена)
    expect(num(r.lastCheck!.discrepancy)).toBe(-50);
    // несведённые — только EXPENSE 200 после 06-08
    expect(r.unreconciled.since).toBe('2026-06-08T00:00:00.000Z');
    expect(r.unreconciled.count).toBe(1);
    expect(num(r.unreconciled.net)).toBe(-200);
    expect(r.unreconciled.operations[0]!.amount).toBe('200.00');
    expect(r.unreconciled.operations[0]!.type).toBe('EXPENSE');
  });

  it('soft-deleted транзакции (deletedAt!=null) исключены из книги и из несведённых', async () => {
    const accId = await makeAccount({ openingBalance: '0' });
    await makeTx({ type: 'INCOME', amount: '300.00', date: '2026-06-05T00:00:00.000Z', accountId: accId });
    await makeTx({
      type: 'INCOME',
      amount: '999.00',
      date: '2026-06-06T00:00:00.000Z',
      accountId: accId,
      deletedAt: new Date('2026-06-06T01:00:00.000Z'),
    });

    const r = await h.reconciliation.build(seed.workspaceId, accId, '2026-06-15T00:00:00.000Z');
    // только живая 300, удалённая 999 не учтена
    expect(num(r.computedBalance)).toBe(300);
    expect(r.unreconciled.count).toBe(1);
    expect(num(r.unreconciled.net)).toBe(300);
  });

  it('транзакции с date > asOf исключаются (asOf-граница) и default asOf=now() ловит всё прошлое', async () => {
    const accId = await makeAccount({ openingBalance: '0' });
    await makeTx({ type: 'INCOME', amount: '100.00', date: '2020-01-01T00:00:00.000Z', accountId: accId });
    // далеко в будущем — мимо now()
    await makeTx({ type: 'INCOME', amount: '777.00', date: '2999-01-01T00:00:00.000Z', accountId: accId });

    // asOf по умолчанию = now(): будущая 777 не попадает, прошлая 100 попадает
    const def = await h.reconciliation.build(seed.workspaceId, accId);
    expect(num(def.computedBalance)).toBe(100);
    expect(def.unreconciled.count).toBe(1);

    // явный asOf в прошлом отсекает даже 100
    const past = await h.reconciliation.build(seed.workspaceId, accId, '2019-12-31T00:00:00.000Z');
    expect(num(past.computedBalance)).toBe(0);
    expect(past.unreconciled.count).toBe(0);
  });

  it('asOf в будущем → возвращает всё до этой даты (включая будущие транзакции)', async () => {
    const accId = await makeAccount({ openingBalance: '0' });
    await makeTx({ type: 'INCOME', amount: '100.00', date: '2026-06-05T00:00:00.000Z', accountId: accId });
    await makeTx({ type: 'INCOME', amount: '50.00', date: '2030-01-01T00:00:00.000Z', accountId: accId });

    const r = await h.reconciliation.build(seed.workspaceId, accId, '2031-01-01T00:00:00.000Z');
    expect(num(r.computedBalance)).toBe(150);
    expect(r.unreconciled.count).toBe(2);
  });

  it('Decimal-точность: дробные суммы складываются без float-погрешности', async () => {
    const accId = await makeAccount({ openingBalance: '0.10' });
    await makeTx({ type: 'INCOME', amount: '0.20', date: '2026-06-05T00:00:00.000Z', accountId: accId });
    // 0.10 + 0.20 = 0.30 (а не 0.30000000000000004)
    const r = await h.reconciliation.build(seed.workspaceId, accId, '2026-06-15T00:00:00.000Z');
    expect(r.computedBalance).toBe('0.30');
    expect(r.openingBalance).toBe('0.10');
  });

  it('берётся ПОСЛЕДНИЙ снимок <= asOf (date desc), discrepancy относительно его даты', async () => {
    const accId = await makeAccount({ openingBalance: '0' });
    await makeTx({ type: 'INCOME', amount: '100.00', date: '2026-06-01T00:00:00.000Z', accountId: accId });
    await makeTx({ type: 'INCOME', amount: '100.00', date: '2026-06-10T00:00:00.000Z', accountId: accId });

    // снимок 1: на 06-05 (книга = 100), факт 90
    await h.reconciliation.createCheck(seed.workspaceId, seed.userId, {
      accountId: accId,
      date: '2026-06-05T00:00:00.000Z',
      actualBalance: '90.00',
    });
    // снимок 2 (более поздний): на 06-12 (книга = 200), факт 205
    await h.reconciliation.createCheck(seed.workspaceId, seed.userId, {
      accountId: accId,
      date: '2026-06-12T00:00:00.000Z',
      actualBalance: '205.00',
    });

    const r = await h.reconciliation.build(seed.workspaceId, accId, '2026-06-20T00:00:00.000Z');
    // последний снимок — 06-12; книга на 06-12 = 200; discrepancy = 205 − 200 = +5
    expect(r.lastCheck!.date).toBe('2026-06-12T00:00:00.000Z');
    expect(num(r.lastCheck!.computedBalance)).toBe(200);
    expect(num(r.lastCheck!.discrepancy)).toBe(5);
    // несведённых после 06-12 нет
    expect(r.unreconciled.count).toBe(0);
    expect(num(r.unreconciled.net)).toBe(0);
  });

  it('гард: несуществующий accountId → NotFoundException', async () => {
    await expect(
      h.reconciliation.build(seed.workspaceId, 'cknotanaccount000000000'),
    ).rejects.toThrow(NotFoundException);
  });

  it('гард: soft-deleted счёт → NotFoundException', async () => {
    const accId = await makeAccount({ deletedAt: new Date() });
    await expect(
      h.reconciliation.build(seed.workspaceId, accId),
    ).rejects.toThrow(NotFoundException);
  });
});

// ─────────────────────── createCheck(): ввод снимка ───────────────────────

describe('D-e2e createCheck: запись факт-снимка', () => {
  it('пишет AccountBalanceCheck в БД с createdById и money()-округлением до 2 знаков', async () => {
    const out = await h.reconciliation.createCheck(seed.workspaceId, seed.userId, {
      accountId: seed.accountId,
      date: '2026-06-10T00:00:00.000Z',
      actualBalance: '1234.5', // одна дробь → 1234.50
      note: 'банковская выписка',
    });
    expect(out.actualBalance).toBe('1234.50');

    const row = await h.prisma.accountBalanceCheck.findUnique({ where: { id: out.id } });
    expect(row).not.toBeNull();
    expect(num(row!.actualBalance)).toBe(1234.5);
    expect(row!.createdById).toBe(seed.userId);
    expect(row!.workspaceId).toBe(seed.workspaceId);
    expect(row!.note).toBe('банковская выписка');
  });

  it('note по умолчанию null, когда не передан', async () => {
    const out = await h.reconciliation.createCheck(seed.workspaceId, seed.userId, {
      accountId: seed.accountId,
      date: '2026-06-10T00:00:00.000Z',
      actualBalance: '100.00',
    });
    expect(out.note).toBeNull();
    const row = await h.prisma.accountBalanceCheck.findUnique({ where: { id: out.id } });
    expect(row!.note).toBeNull();
  });

  it('отрицательный actualBalance (овердрафт) сохраняется как есть', async () => {
    const out = await h.reconciliation.createCheck(seed.workspaceId, seed.userId, {
      accountId: seed.accountId,
      date: '2026-06-10T00:00:00.000Z',
      actualBalance: '-50.25',
    });
    expect(num(out.actualBalance)).toBe(-50.25);
  });

  it('append-only: один счёт может иметь несколько снимков на разные даты (нет unique)', async () => {
    await h.reconciliation.createCheck(seed.workspaceId, seed.userId, {
      accountId: seed.accountId,
      date: '2026-06-01T00:00:00.000Z',
      actualBalance: '100.00',
    });
    await h.reconciliation.createCheck(seed.workspaceId, seed.userId, {
      accountId: seed.accountId,
      date: '2026-06-02T00:00:00.000Z',
      actualBalance: '120.00',
    });
    const count = await h.prisma.accountBalanceCheck.count({
      where: { workspaceId: seed.workspaceId, accountId: seed.accountId },
    });
    expect(count).toBe(2);
  });

  it('date в будущем — сохраняется (бизнес-валидация сроков не на БД)', async () => {
    const out = await h.reconciliation.createCheck(seed.workspaceId, seed.userId, {
      accountId: seed.accountId,
      date: '2999-12-31T00:00:00.000Z',
      actualBalance: '10.00',
    });
    expect(out.date).toBe('2999-12-31T00:00:00.000Z');
  });

  it('гард: несуществующий accountId → NotFoundException, в БД ничего не создано', async () => {
    await expect(
      h.reconciliation.createCheck(seed.workspaceId, seed.userId, {
        accountId: 'cknotanaccount000000000',
        date: '2026-06-10T00:00:00.000Z',
        actualBalance: '100.00',
      }),
    ).rejects.toThrow(NotFoundException);
    const count = await h.prisma.accountBalanceCheck.count({ where: { workspaceId: seed.workspaceId } });
    expect(count).toBe(0);
  });

  it('гард: soft-deleted счёт → NotFoundException', async () => {
    const accId = await makeAccount({ deletedAt: new Date() });
    await expect(
      h.reconciliation.createCheck(seed.workspaceId, seed.userId, {
        accountId: accId,
        date: '2026-06-10T00:00:00.000Z',
        actualBalance: '100.00',
      }),
    ).rejects.toThrow(NotFoundException);
  });
});

// ─────────────────────── listChecks(): история ───────────────────────

describe('D-e2e listChecks: история снимков', () => {
  it('сортировка date desc, затем createdAt desc (новые первыми)', async () => {
    // две даты; для одинаковой даты вторая (более поздний createdAt) должна идти первой
    const a = await h.reconciliation.createCheck(seed.workspaceId, seed.userId, {
      accountId: seed.accountId,
      date: '2026-06-05T00:00:00.000Z',
      actualBalance: '50.00',
    });
    const b = await h.reconciliation.createCheck(seed.workspaceId, seed.userId, {
      accountId: seed.accountId,
      date: '2026-06-05T00:00:00.000Z',
      actualBalance: '60.00',
    });
    const c = await h.reconciliation.createCheck(seed.workspaceId, seed.userId, {
      accountId: seed.accountId,
      date: '2026-06-10T00:00:00.000Z',
      actualBalance: '70.00',
    });

    const list = await h.reconciliation.listChecks(seed.workspaceId, seed.accountId);
    expect(list.map((x) => x.id)).toEqual([c.id, b.id, a.id]);
  });

  it('без accountId → все снимки workspace по всем счетам', async () => {
    const accId = await makeAccount();
    await h.reconciliation.createCheck(seed.workspaceId, seed.userId, {
      accountId: seed.accountId,
      date: '2026-06-05T00:00:00.000Z',
      actualBalance: '10.00',
    });
    await h.reconciliation.createCheck(seed.workspaceId, seed.userId, {
      accountId: accId,
      date: '2026-06-06T00:00:00.000Z',
      actualBalance: '20.00',
    });
    const all = await h.reconciliation.listChecks(seed.workspaceId);
    expect(all).toHaveLength(2);
    const byAcc = await h.reconciliation.listChecks(seed.workspaceId, accId);
    expect(byAcc).toHaveLength(1);
    expect(byAcc[0]!.accountId).toBe(accId);
  });

  it('actualBalance сериализуется как денежная строка с 2 знаками', async () => {
    await h.reconciliation.createCheck(seed.workspaceId, seed.userId, {
      accountId: seed.accountId,
      date: '2026-06-05T00:00:00.000Z',
      actualBalance: '5', // целое → "5.00"
    });
    const list = await h.reconciliation.listChecks(seed.workspaceId, seed.accountId);
    expect(list[0]!.actualBalance).toBe('5.00');
  });

  it('гард: accountId не существует → NotFoundException (а не пустой список)', async () => {
    await expect(
      h.reconciliation.listChecks(seed.workspaceId, 'cknotanaccount000000000'),
    ).rejects.toThrow(NotFoundException);
  });

  it('фильтр по счёту без снимков → пустой список (счёт существует)', async () => {
    const accId = await makeAccount();
    const list = await h.reconciliation.listChecks(seed.workspaceId, accId);
    expect(list).toEqual([]);
  });
});

// ─────────────────────── deleteCheck(): удаление ───────────────────────

describe('D-e2e deleteCheck: физическое удаление снимка', () => {
  it('удаляет строку из БД физически (не soft-delete)', async () => {
    const created = await h.reconciliation.createCheck(seed.workspaceId, seed.userId, {
      accountId: seed.accountId,
      date: '2026-06-05T00:00:00.000Z',
      actualBalance: '100.00',
    });
    await h.reconciliation.deleteCheck(seed.workspaceId, created.id);
    const row = await h.prisma.accountBalanceCheck.findUnique({ where: { id: created.id } });
    expect(row).toBeNull();
  });

  it('после удаления последнего снимка discrepancy пересчитывается с предыдущего (или с начала)', async () => {
    const accId = await makeAccount({ openingBalance: '0' });
    await makeTx({ type: 'INCOME', amount: '100.00', date: '2026-06-01T00:00:00.000Z', accountId: accId });
    await makeTx({ type: 'INCOME', amount: '100.00', date: '2026-06-10T00:00:00.000Z', accountId: accId });

    const early = await h.reconciliation.createCheck(seed.workspaceId, seed.userId, {
      accountId: accId,
      date: '2026-06-05T00:00:00.000Z',
      actualBalance: '95.00',
    });
    const late = await h.reconciliation.createCheck(seed.workspaceId, seed.userId, {
      accountId: accId,
      date: '2026-06-12T00:00:00.000Z',
      actualBalance: '210.00',
    });

    // До удаления: последний — late (06-12). книга = 200, discrepancy = +10
    const before = await h.reconciliation.build(seed.workspaceId, accId, '2026-06-20T00:00:00.000Z');
    expect(before.lastCheck!.id).toBe(late.id);
    expect(num(before.lastCheck!.discrepancy)).toBe(10);
    expect(before.unreconciled.count).toBe(0);

    // Удаляем поздний снимок → откатывается к early (06-05).
    await h.reconciliation.deleteCheck(seed.workspaceId, late.id);
    const after = await h.reconciliation.build(seed.workspaceId, accId, '2026-06-20T00:00:00.000Z');
    expect(after.lastCheck!.id).toBe(early.id);
    // книга на 06-05 = 100; факт 95; discrepancy = 95 − 100 = −5
    expect(num(after.lastCheck!.computedBalance)).toBe(100);
    expect(num(after.lastCheck!.discrepancy)).toBe(-5);
    // несведённые теперь — INCOME 100 на 06-10 (после 06-05)
    expect(after.unreconciled.since).toBe('2026-06-05T00:00:00.000Z');
    expect(after.unreconciled.count).toBe(1);
    expect(num(after.unreconciled.net)).toBe(100);

    // Удаляем и ранний → снимков не осталось, since=null, все операции несведены.
    await h.reconciliation.deleteCheck(seed.workspaceId, early.id);
    const none = await h.reconciliation.build(seed.workspaceId, accId, '2026-06-20T00:00:00.000Z');
    expect(none.lastCheck).toBeNull();
    expect(none.unreconciled.since).toBeNull();
    expect(none.unreconciled.count).toBe(2);
    expect(num(none.unreconciled.net)).toBe(200);
  });

  it('гард: несуществующий id → NotFoundException', async () => {
    await expect(
      h.reconciliation.deleteCheck(seed.workspaceId, 'cknotacheck0000000000000'),
    ).rejects.toThrow(NotFoundException);
  });

  it('изоляция: снимок другого workspace не удаляется (NotFound), строка остаётся', async () => {
    const created = await h.reconciliation.createCheck(seed.workspaceId, seed.userId, {
      accountId: seed.accountId,
      date: '2026-06-05T00:00:00.000Z',
      actualBalance: '100.00',
    });
    // чужой workspace
    const otherUser = await h.prisma.user.create({
      data: { telegramId: tg + 500000n, username: 'other', firstName: 'Other' },
    });
    const otherWs = await h.prisma.workspace.create({
      data: { name: 'Other WS', ownerId: otherUser.id },
    });
    await expect(
      h.reconciliation.deleteCheck(otherWs.id, created.id),
    ).rejects.toThrow(NotFoundException);
    const row = await h.prisma.accountBalanceCheck.findUnique({ where: { id: created.id } });
    expect(row).not.toBeNull();
  });
});
