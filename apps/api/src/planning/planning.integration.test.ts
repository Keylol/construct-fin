/**
 * Интеграционные тесты Ф5 (регулярка + плановые платежи) на реальной БД
 * construct_v6_test: материализация идемпотентна, оплата кладёт проводку на
 * общую шину, отмена авто-проводки удаляет её, привязка существующей — нет,
 * cross-tenant изоляция, статусы.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { buildHarness, resetDb, seedBase, type Harness, type Seed } from '../test/money-harness';

let h: Harness;
let seed: Seed;
let other: Seed;
let categoryId: string;
let employeeId: string;
let tg = 3_100_000n;

const DAY = 86_400_000;
const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();

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
  tg += 1n;
  other = await seedBase(h.prisma, tg);
  const cat = await h.prisma.category.create({
    data: { workspaceId: seed.workspaceId, name: 'Аренда', kind: 'EXPENSE' },
  });
  categoryId = cat.id;
  const emp = await h.prisma.counterparty.create({
    data: { workspaceId: seed.workspaceId, name: 'Иванов', role: 'EMPLOYEE' },
  });
  employeeId = emp.id;
});

describe('Регулярка + материализация', () => {
  it('materialize идемпотентен: повторный прогон не задваивает', async () => {
    await h.planning.createRecurring(seed.workspaceId, seed.userId, {
      title: 'Аренда офиса',
      amount: '30000.00',
      txKind: 'FIXED_COST',
      cadence: 'MONTHLY',
      dayOfMonth: 1,
      leadDays: 3,
      isActive: true,
      startDate: iso(-120 * DAY),
      accountId: seed.accountId,
      categoryId,
    });

    const first = await h.planning.materialize(seed.workspaceId, 45);
    expect(first.created).toBeGreaterThanOrEqual(1);
    const countAfter1 = await h.prisma.plannedPayment.count({
      where: { workspaceId: seed.workspaceId, deletedAt: null },
    });

    const second = await h.planning.materialize(seed.workspaceId, 45);
    expect(second.created).toBe(0);
    const countAfter2 = await h.prisma.plannedPayment.count({
      where: { workspaceId: seed.workspaceId, deletedAt: null },
    });
    expect(countAfter2).toBe(countAfter1);

    const rows = await h.planning.listPlanned(seed.workspaceId, { source: 'RECURRING' });
    expect(rows.length).toBe(countAfter1);
    expect(rows.every((r) => r.status === 'PLANNED' && r.recurringId)).toBe(true);
    expect(rows.every((r) => r.amount === '30000.00')).toBe(true);
  });

  it('deleteRecurring отменяет будущие ожидаемые позиции правила', async () => {
    const rec = await h.planning.createRecurring(seed.workspaceId, seed.userId, {
      title: 'Подписка',
      amount: '990.00',
      txKind: 'FIXED_COST',
      cadence: 'MONTHLY',
      dayOfMonth: 1,
      leadDays: 3,
      isActive: true,
      startDate: iso(-120 * DAY),
    });
    await h.planning.materialize(seed.workspaceId, 45);
    const before = await h.prisma.plannedPayment.count({
      where: { workspaceId: seed.workspaceId, status: 'PLANNED', deletedAt: null },
    });
    expect(before).toBeGreaterThanOrEqual(1);

    await h.planning.deleteRecurring(seed.workspaceId, rec.id);

    const stillPlanned = await h.prisma.plannedPayment.count({
      where: { workspaceId: seed.workspaceId, status: 'PLANNED', deletedAt: null },
    });
    expect(stillPlanned).toBe(0);
    const cancelled = await h.prisma.plannedPayment.count({
      where: { workspaceId: seed.workspaceId, status: 'CANCELLED', deletedAt: null },
    });
    expect(cancelled).toBe(before);
    const rule = await h.prisma.recurringPayment.findUnique({ where: { id: rec.id } });
    expect(rule?.deletedAt).not.toBeNull();
    expect(rule?.isActive).toBe(false);
  });
});

describe('Ближайшие платежи (upcoming)', () => {
  it('флаги overdue/soon и счётчики', async () => {
    // Просроченный (2 дня назад).
    await h.planning.createPlanned(seed.workspaceId, seed.userId, {
      title: 'Просрочка',
      amount: '1000.00',
      txKind: 'FIXED_COST',
      dueDate: iso(-2 * DAY),
      source: 'MANUAL',
      leadDays: 3,
    });
    // Горит (через 2 дня, leadDays=3).
    await h.planning.createPlanned(seed.workspaceId, seed.userId, {
      title: 'Скоро',
      amount: '2000.00',
      txKind: 'FIXED_COST',
      dueDate: iso(2 * DAY),
      source: 'MANUAL',
      leadDays: 3,
    });
    // Далеко (через 20 дней, в горизонте 30, но не soon).
    await h.planning.createPlanned(seed.workspaceId, seed.userId, {
      title: 'Далеко',
      amount: '3000.00',
      txKind: 'FIXED_COST',
      dueDate: iso(20 * DAY),
      source: 'MANUAL',
      leadDays: 3,
    });

    const up = await h.planning.upcoming(seed.workspaceId, 30);
    const overdue = up.items.find((i) => i.title === 'Просрочка')!;
    const soon = up.items.find((i) => i.title === 'Скоро')!;
    const far = up.items.find((i) => i.title === 'Далеко')!;

    expect(overdue.overdue).toBe(true);
    expect(overdue.dueInDays).toBeLessThan(0);
    expect(soon.soon).toBe(true);
    expect(soon.overdue).toBe(false);
    expect(far.overdue).toBe(false);
    expect(far.soon).toBe(false);

    expect(up.overdueCount).toBe(1);
    expect(up.soonCount).toBe(1);
    expect(up.overdueSum).toBe('1000.00');
    expect(up.soonSum).toBe('2000.00');
  });
});

describe('Оплата плана → шина', () => {
  it('оплата создаёт EXPENSE-проводку нужного kind, статус PAID', async () => {
    const plan = await h.planning.createPlanned(seed.workspaceId, seed.userId, {
      title: 'Аренда',
      amount: '5000.00',
      txKind: 'FIXED_COST',
      dueDate: iso(-1 * DAY),
      source: 'MANUAL',
      leadDays: 3,
      categoryId,
    });

    const res = await h.planning.payPlanned(seed.workspaceId, seed.userId, plan.id, {
      accountId: seed.accountId,
      amount: '5000.00',
      date: iso(-1 * DAY),
    });
    expect(res.transactionId).toBeTruthy();

    const tx = await h.prisma.transaction.findUnique({ where: { id: res.transactionId! } });
    expect(tx?.type).toBe('EXPENSE');
    expect(tx?.kind).toBe('FIXED_COST');
    expect(tx?.amount.toFixed(2)).toBe('5000.00');
    expect(tx?.categoryId).toBe(categoryId);

    const after = await h.prisma.plannedPayment.findUnique({ where: { id: plan.id } });
    expect(after?.status).toBe('PAID');
    expect(after?.matchedTransactionId).toBe(res.transactionId);
    expect(after?.autoTx).toBe(true);
  });

  it('revert авто-оплаты удаляет созданную проводку и возвращает в PLANNED', async () => {
    const plan = await h.planning.createPlanned(seed.workspaceId, seed.userId, {
      title: 'Возврат',
      amount: '4000.00',
      txKind: 'FIXED_COST',
      dueDate: iso(-1 * DAY),
      source: 'MANUAL',
      leadDays: 3,
    });
    const res = await h.planning.payPlanned(seed.workspaceId, seed.userId, plan.id, {
      accountId: seed.accountId,
      amount: '4000.00',
      date: iso(-1 * DAY),
    });
    await h.planning.revertPlanned(seed.workspaceId, plan.id);

    const after = await h.prisma.plannedPayment.findUnique({ where: { id: plan.id } });
    expect(after?.status).toBe('PLANNED');
    expect(after?.matchedTransactionId).toBeNull();
    expect(after?.autoTx).toBe(false);
    const tx = await h.prisma.transaction.findUnique({ where: { id: res.transactionId! } });
    expect(tx?.deletedAt).not.toBeNull(); // авто-проводка мягко удалена
  });

  it('привязка существующей операции (autoTx=false); revert только отвязывает', async () => {
    const existingTx = await h.prisma.transaction.create({
      data: {
        workspaceId: seed.workspaceId,
        accountId: seed.accountId,
        date: new Date(iso(-3 * DAY)),
        amount: '7000.00',
        type: 'EXPENSE',
        kind: 'FIXED_COST',
        createdById: seed.userId,
      },
    });
    const plan = await h.planning.createPlanned(seed.workspaceId, seed.userId, {
      title: 'Привязка',
      amount: '7000.00',
      txKind: 'FIXED_COST',
      dueDate: iso(-3 * DAY),
      source: 'MANUAL',
      leadDays: 3,
    });
    await h.planning.payPlanned(seed.workspaceId, seed.userId, plan.id, {
      transactionId: existingTx.id,
    });
    const paid = await h.prisma.plannedPayment.findUnique({ where: { id: plan.id } });
    expect(paid?.status).toBe('PAID');
    expect(paid?.matchedTransactionId).toBe(existingTx.id);
    expect(paid?.autoTx).toBe(false);

    await h.planning.revertPlanned(seed.workspaceId, plan.id);
    const tx = await h.prisma.transaction.findUnique({ where: { id: existingTx.id } });
    expect(tx?.deletedAt).toBeNull(); // привязанную НЕ удаляем
  });

  it('одну операцию нельзя привязать к двум планам → конфликт', async () => {
    const tx = await h.prisma.transaction.create({
      data: {
        workspaceId: seed.workspaceId,
        accountId: seed.accountId,
        date: new Date(iso(-1 * DAY)),
        amount: '100.00',
        type: 'EXPENSE',
        kind: 'FIXED_COST',
        createdById: seed.userId,
      },
    });
    const mk = () =>
      h.planning.createPlanned(seed.workspaceId, seed.userId, {
        title: 'P',
        amount: '100.00',
        txKind: 'FIXED_COST',
        dueDate: iso(-1 * DAY),
        source: 'MANUAL',
        leadDays: 3,
      });
    const p1 = await mk();
    const p2 = await mk();
    await h.planning.payPlanned(seed.workspaceId, seed.userId, p1.id, { transactionId: tx.id });
    await expect(
      h.planning.payPlanned(seed.workspaceId, seed.userId, p2.id, { transactionId: tx.id }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('Статусы и правки', () => {
  it('править можно только PLANNED; оплаченный — нельзя', async () => {
    const plan = await h.planning.createPlanned(seed.workspaceId, seed.userId, {
      title: 'ЗП',
      amount: '20000.00',
      txKind: 'SALARY',
      dueDate: iso(-1 * DAY),
      source: 'SALARY',
      leadDays: 3,
      counterpartyId: employeeId,
    });
    // Зарплатный план получает kind=SALARY.
    const created = await h.prisma.plannedPayment.findUnique({ where: { id: plan.id } });
    expect(created?.txKind).toBe('SALARY');

    await h.planning.payPlanned(seed.workspaceId, seed.userId, plan.id, {
      accountId: seed.accountId,
      amount: '20000.00',
      date: iso(-1 * DAY),
    });
    await expect(
      h.planning.updatePlanned(seed.workspaceId, plan.id, { amount: '21000.00' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('setPlannedStatus SKIP; PAID нельзя менять статусом', async () => {
    const skip = await h.planning.createPlanned(seed.workspaceId, seed.userId, {
      title: 'Пропуск',
      amount: '1.00',
      txKind: 'FIXED_COST',
      dueDate: iso(1 * DAY),
      source: 'MANUAL',
      leadDays: 3,
    });
    await h.planning.setPlannedStatus(seed.workspaceId, skip.id, 'SKIPPED');
    const s = await h.prisma.plannedPayment.findUnique({ where: { id: skip.id } });
    expect(s?.status).toBe('SKIPPED');

    const paid = await h.planning.createPlanned(seed.workspaceId, seed.userId, {
      title: 'Оплачен',
      amount: '1.00',
      txKind: 'FIXED_COST',
      dueDate: iso(-1 * DAY),
      source: 'MANUAL',
      leadDays: 3,
    });
    await h.planning.payPlanned(seed.workspaceId, seed.userId, paid.id, {
      accountId: seed.accountId,
      amount: '1.00',
      date: iso(-1 * DAY),
    });
    await expect(
      h.planning.setPlannedStatus(seed.workspaceId, paid.id, 'CANCELLED'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('Cross-tenant изоляция', () => {
  it('чужое пространство не видит/не правит регулярку и план', async () => {
    const rec = await h.planning.createRecurring(seed.workspaceId, seed.userId, {
      title: 'X',
      amount: '1.00',
      txKind: 'FIXED_COST',
      cadence: 'MONTHLY',
      dayOfMonth: 1,
      leadDays: 3,
      isActive: true,
      startDate: iso(-30 * DAY),
    });
    await expect(
      h.planning.updateRecurring(other.workspaceId, rec.id, { amount: '2.00' }),
    ).rejects.toBeInstanceOf(NotFoundException);

    const plan = await h.planning.createPlanned(seed.workspaceId, seed.userId, {
      title: 'Y',
      amount: '1.00',
      txKind: 'FIXED_COST',
      dueDate: iso(-1 * DAY),
      source: 'MANUAL',
      leadDays: 3,
    });
    await expect(
      h.planning.payPlanned(other.workspaceId, other.userId, plan.id, {
        accountId: other.accountId,
        amount: '1.00',
        date: iso(-1 * DAY),
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
