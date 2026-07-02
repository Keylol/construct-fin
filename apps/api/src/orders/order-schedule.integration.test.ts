/**
 * F2 (#8a): график платежей заказа против реальной БД construct_v6_test.
 *
 * Путь целиком: PUT-замена графика → блок schedule во всех ответах заказа →
 * FIFO-покрытие из paidAmount после оплат → откат покрытия после рефанда →
 * просрочка в summary и в списке заказов (scheduleSummary).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildHarness, resetDb, seedBase, type Harness, type Seed } from '../test/money-harness';

let h: Harness;
let seed: Seed;
let tg = 2730000n;

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

const PAST = '2026-01-15T00:00:00.000Z'; // заведомо просрочено к моменту прогона
const FUTURE_A = '2099-01-10T00:00:00.000Z';
const FUTURE_B = '2099-02-10T00:00:00.000Z';

async function makeOrder(total = '1000.00') {
  return h.orders.create(seed.workspaceId, {
    items: [{ name: 'Кухня', qty: '1', unitPrice: total }],
  });
}

describe('F2: график платежей — API', () => {
  it('PUT создаёт график; schedule приходит в ответе мутации и в get', async () => {
    const order = await makeOrder();
    const updated = await h.orders.setSchedule(seed.workspaceId, order.id, seed.userId, {
      entries: [
        { dueDate: FUTURE_A, amount: '400.00', note: 'аванс' },
        { dueDate: FUTURE_B, amount: '600.00' },
      ],
    });
    expect(updated.schedule).not.toBeNull();
    expect(updated.schedule!.entries.map((e) => e.status)).toEqual(['PENDING', 'PENDING']);
    expect(updated.schedule!.summary).toMatchObject({
      planned: '1000.00',
      matchesTotal: true,
      overdueAmount: '0.00',
      nextDueDate: FUTURE_A,
      nextDueAmount: '400.00',
    });

    const got = await h.orders.get(seed.workspaceId, order.id);
    expect(got.schedule!.entries).toHaveLength(2);
    expect(got.schedule!.entries[0]!.note).toBe('аванс');
  });

  it('оплата гасит строки FIFO; ответ addPayment уже с покрытием', async () => {
    const order = await makeOrder();
    await h.orders.setSchedule(seed.workspaceId, order.id, seed.userId, {
      entries: [
        { dueDate: FUTURE_A, amount: '400.00' },
        { dueDate: FUTURE_B, amount: '600.00' },
      ],
    });
    const paid = await h.orders.addPayment(seed.workspaceId, order.id, seed.userId, {
      amount: '500.00',
      accountId: seed.accountId,
    });
    expect(paid.schedule!.entries.map((e) => e.status)).toEqual(['PAID', 'PARTIAL']);
    expect(paid.schedule!.entries[1]!.covered).toBe('100.00');
    expect(paid.schedule!.summary.nextDueAmount).toBe('500.00');
  });

  it('просроченная строка → OVERDUE в карточке и scheduleSummary в списке', async () => {
    const order = await makeOrder();
    await h.orders.setSchedule(seed.workspaceId, order.id, seed.userId, {
      entries: [
        { dueDate: PAST, amount: '300.00' },
        { dueDate: FUTURE_A, amount: '700.00' },
      ],
    });
    const got = await h.orders.get(seed.workspaceId, order.id);
    expect(got.schedule!.entries[0]!.status).toBe('OVERDUE');
    expect(got.schedule!.summary.overdueAmount).toBe('300.00');

    const page = await h.orders.list(seed.workspaceId, {});
    const row = page.items.find((o) => o.id === order.id)!;
    expect(row.scheduleSummary).not.toBeNull();
    expect(row.scheduleSummary!.overdueAmount).toBe('300.00');
    // Сырые строки в список не отдаются.
    expect((row as Record<string, unknown>).schedule).toBeUndefined();
  });

  it('заказ без графика: schedule=null в карточке, scheduleSummary=null в списке', async () => {
    const order = await makeOrder();
    const got = await h.orders.get(seed.workspaceId, order.id);
    expect(got.schedule).toBeNull();
    const page = await h.orders.list(seed.workspaceId, {});
    expect(page.items.find((o) => o.id === order.id)!.scheduleSummary).toBeNull();
  });

  it('повторный PUT переписывает график целиком; пустой массив снимает его', async () => {
    const order = await makeOrder();
    await h.orders.setSchedule(seed.workspaceId, order.id, seed.userId, {
      entries: [{ dueDate: FUTURE_A, amount: '1000.00' }],
    });
    const replaced = await h.orders.setSchedule(seed.workspaceId, order.id, seed.userId, {
      entries: [
        { dueDate: FUTURE_A, amount: '500.00' },
        { dueDate: FUTURE_B, amount: '500.00' },
      ],
    });
    expect(replaced.schedule!.entries).toHaveLength(2);

    const cleared = await h.orders.setSchedule(seed.workspaceId, order.id, seed.userId, {
      entries: [],
    });
    expect(cleared.schedule).toBeNull();
    // Строк в БД не осталось (hard delete при replace, как items заказа).
    const rows = await h.prisma.paymentScheduleEntry.findMany({
      where: { orderId: order.id },
    });
    expect(rows).toHaveLength(0);
  });

  it('CANCELLED-заказ: менять график нельзя', async () => {
    const order = await makeOrder();
    await h.orders.cancel(seed.workspaceId, order.id, seed.userId);
    await expect(
      h.orders.setSchedule(seed.workspaceId, order.id, seed.userId, {
        entries: [{ dueDate: FUTURE_A, amount: '100.00' }],
      }),
    ).rejects.toThrow('Заказ отменён');
  });

  it('Σ ≠ итогу заказа — сохраняется, но matchesTotal=false (мягкое предупреждение)', async () => {
    const order = await makeOrder('1000.00');
    const updated = await h.orders.setSchedule(seed.workspaceId, order.id, seed.userId, {
      entries: [{ dueDate: FUTURE_A, amount: '800.00' }],
    });
    expect(updated.schedule!.summary.planned).toBe('800.00');
    expect(updated.schedule!.summary.matchesTotal).toBe(false);
  });

  it('дебиторка: overdueByPlan на заказ, клиента и общий итог', async () => {
    const order = await makeOrder('1000.00');
    await h.orders.setSchedule(seed.workspaceId, order.id, seed.userId, {
      entries: [
        { dueDate: PAST, amount: '300.00' },
        { dueDate: FUTURE_A, amount: '700.00' },
      ],
    });
    await h.orders.addPayment(seed.workspaceId, order.id, seed.userId, {
      amount: '100.00',
      accountId: seed.accountId,
    });
    // Второй заказ без графика — не влияет на overdueByPlanTotal.
    await makeOrder('500.00');

    const rep = await h.tradeReceivables.build(seed.workspaceId);
    expect(rep.overdueByPlanTotal).toBe('200.00'); // 300 − 100 покрытия
    const rows = rep.clients.flatMap((c) => c.orders);
    const withPlan = rows.find((r) => r.orderId === order.id)!;
    expect(withPlan.overdueByPlan).toBe('200.00');
    expect(withPlan.nextDueDate).toBe(PAST); // первая непогашенная — просроченная
    const noPlan = rows.find((r) => r.orderId !== order.id)!;
    expect(noPlan.overdueByPlan).toBeNull();
  });

  it('рефанд уменьшает paidAmount → покрытие строк откатывается', async () => {
    const order = await makeOrder('1000.00');
    const itemId = order.items[0]!.id;
    await h.orders.setSchedule(seed.workspaceId, order.id, seed.userId, {
      entries: [
        { dueDate: FUTURE_A, amount: '400.00' },
        { dueDate: FUTURE_B, amount: '600.00' },
      ],
    });
    await h.orders.addPayment(seed.workspaceId, order.id, seed.userId, {
      amount: '400.00',
      accountId: seed.accountId,
    });
    await h.orders.finalize(seed.workspaceId, order.id, seed.userId);

    // Возврат с рефандом 250: paid 400 → 150, первая строка снова частичная.
    const after = await h.orders.returnItem(seed.workspaceId, order.id, seed.userId, {
      itemId,
      returnQty: '1',
      refundAmount: '250.00',
      accountId: seed.accountId,
    });
    expect(after.paidAmount.toFixed(2)).toBe('150.00');
    expect(after.schedule!.entries[0]!.status).toBe('PARTIAL');
    expect(after.schedule!.entries[0]!.covered).toBe('150.00');
  });
});
