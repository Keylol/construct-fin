/**
 * Интеграционные тесты прогноза остатка: старт из остатков счетов, оттоки из
 * плановых платежей (просроченные — на сегодня), притоки из будущих строк
 * графиков открытых заказов, детекция первого дня кассового разрыва.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildHarness, resetDb, seedBase, type Harness, type Seed } from '../test/money-harness';

let h: Harness;
let seed: Seed;
let tg = 3_400_000n;

const DAY = 86_400_000;
const inDays = (n: number) => new Date(Date.now() + n * DAY);

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

describe('Прогноз остатка (кассовый разрыв)', () => {
  it('оттоки просаживают остаток; разрыв найден в правильный день; приток графика спасает', async () => {
    // Старт: 50 000 на счёте.
    await h.prisma.account.update({
      where: { id: seed.accountId },
      data: { openingBalance: '50000.00' },
    });
    // Плановые оттоки: 30 000 через 5 дней и 30 000 через 10 дней → без притоков
    // минус наступает на 10-й день (50 − 30 − 30 = −10 000).
    await h.prisma.plannedPayment.createMany({
      data: [
        {
          workspaceId: seed.workspaceId,
          title: 'Аренда',
          amount: '30000.00',
          txKind: 'FIXED_COST',
          dueDate: inDays(5),
          source: 'MANUAL',
          status: 'PLANNED',
          createdById: seed.userId,
        },
        {
          workspaceId: seed.workspaceId,
          title: 'Поставщик',
          amount: '30000.00',
          txKind: 'VARIABLE_COST',
          dueDate: inDays(10),
          source: 'MANUAL',
          status: 'PLANNED',
          createdById: seed.userId,
        },
      ],
    });
    // Открытый заказ с графиком: клиент должен внести 25 000 через 7 дней.
    await h.prisma.order.create({
      data: {
        workspaceId: seed.workspaceId,
        number: 'F-1',
        status: 'OPEN',
        paymentStatus: 'UNPAID',
        totalAmount: '25000.00',
        paidAmount: '0.00',
        schedule: {
          create: [{ workspaceId: seed.workspaceId, seq: 1, dueDate: inDays(7), amount: '25000.00' }],
        },
      },
    });

    const f = await h.forecast.build(seed.workspaceId, 30);
    expect(f.opening).toBe('50000.00');
    expect(f.totals.out).toBe('60000.00');
    expect(f.totals.in).toBe('25000.00');

    // Пессимистичная траектория уходит в минус на 10-й день.
    expect(f.firstGapOut).not.toBeNull();
    const gapIdx = f.points.findIndex((p) => Number(p.balanceOut) < 0);
    expect(gapIdx).toBe(10);
    // Ожидаемая (с притоком 25 000 на 7-й день) в минус не уходит:
    // 50 − 30 + 25 − 30 = 15 000.
    expect(f.firstGapIn).toBeNull();
    expect(Number(f.points[f.points.length - 1]!.balance)).toBe(15000);
  });

  it('просроченный плановый платёж ложится на сегодня; просроченный приток — только справкой', async () => {
    await h.prisma.account.update({
      where: { id: seed.accountId },
      data: { openingBalance: '10000.00' },
    });
    // Просроченный отток 15 000 (3 дня назад) → минус уже «сегодня».
    await h.prisma.plannedPayment.create({
      data: {
        workspaceId: seed.workspaceId,
        title: 'Просрочка',
        amount: '15000.00',
        txKind: 'FIXED_COST',
        dueDate: inDays(-3),
        source: 'MANUAL',
        status: 'PLANNED',
        createdById: seed.userId,
      },
    });
    // Просроченное ожидание от клиента 40 000 — в траекторию не входит.
    await h.prisma.order.create({
      data: {
        workspaceId: seed.workspaceId,
        number: 'F-2',
        status: 'OPEN',
        paymentStatus: 'UNPAID',
        totalAmount: '40000.00',
        paidAmount: '0.00',
        schedule: {
          create: [{ workspaceId: seed.workspaceId, seq: 1, dueDate: inDays(-2), amount: '40000.00' }],
        },
      },
    });

    const f = await h.forecast.build(seed.workspaceId, 14);
    expect(f.points[0]!.out).toBe('15000.00');
    expect(f.points[0]!.balanceOut).toBe('-5000.00');
    expect(f.firstGapOut).toBe(f.points[0]!.date);
    expect(f.totals.in).toBe('0.00');
    expect(f.overdueExpectedIn).toBe('40000.00');
    // Ожидаемая траектория без просроченного притока — тоже в минусе сразу.
    expect(f.firstGapIn).toBe(f.points[0]!.date);
  });

  it('оплаченные/отменённые планы и закрытые заказы в прогноз не попадают', async () => {
    await h.prisma.account.update({
      where: { id: seed.accountId },
      data: { openingBalance: '5000.00' },
    });
    await h.prisma.plannedPayment.createMany({
      data: (['PAID', 'SKIPPED', 'CANCELLED'] as const).map((status, i) => ({
        workspaceId: seed.workspaceId,
        title: `Не считается ${status}`,
        amount: '99999.00',
        txKind: 'FIXED_COST' as const,
        dueDate: inDays(3 + i),
        source: 'MANUAL' as const,
        status,
        createdById: seed.userId,
      })),
    });
    // График закрытого заказа — не приток (деньги уже получены/не ожидаются).
    await h.prisma.order.create({
      data: {
        workspaceId: seed.workspaceId,
        number: 'F-3',
        status: 'DONE',
        paymentStatus: 'PAID',
        totalAmount: '70000.00',
        paidAmount: '70000.00',
        closedAt: new Date(),
        schedule: { create: [{ workspaceId: seed.workspaceId, seq: 1, dueDate: inDays(5), amount: '70000.00' }] },
      },
    });

    const f = await h.forecast.build(seed.workspaceId, 14);
    expect(f.totals.out).toBe('0.00');
    expect(f.totals.in).toBe('0.00');
    expect(f.firstGapOut).toBeNull();
    expect(f.points[f.points.length - 1]!.balance).toBe('5000.00');
  });
});
