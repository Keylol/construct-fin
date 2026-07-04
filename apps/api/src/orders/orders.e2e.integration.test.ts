/**
 * E2E (DB-backed) сценарии ЖИЗНЕННОГО ЦИКЛА заказа против реальной БД
 * (construct_v6_test). Фокус — переходы статусов и их полные эффекты ПО ДАННЫМ:
 * создать → оплатить → отгрузить → закрыть → возврат → отмена → переоткрыть →
 * удалить, включая edge-кейсы и гварды.
 *
 * НЕ дублирует уже покрытое:
 *   • money-flows.integration.test.ts — create→finalize→COGS, cancel(DONE)→storno,
 *     payment UNPAID→PARTIAL→PAID→OVERPAID, oversell-атомарность, concurrency;
 *   • shipping.integration.test.ts — частичная отгрузка, weighted cost,
 *     cancel/remove частичного OPEN, ship-гварды;
 *   • returns.integration.test.ts — RMA (restock/returnedQty/ORDER_REFUND/гварды).
 *
 * Augment: нумерация (nextNumber), вычисление subtotal/discount/total в create,
 * update (replace items recompute + discount-only recompute + гварды),
 * reopen (DONE→OPEN и CANCELLED→OPEN, restock + storno COGS + пересчёт оплаты),
 * remove (soft-delete + сторно ВСЕХ транзакций включая платежи/возвраты),
 * addPayment-гвард на CANCELLED, состояние REFUNDED, идемпотентность
 * finalize/cancel, finalize на CANCELLED, get/list-фильтры.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  buildHarness,
  resetDb,
  seedBase,
  seedWarehouseItem,
  type Harness,
  type Seed,
} from '../test/money-harness';

let h: Harness;
let seed: Seed;
let tg = 1300000n;

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

const itemOf = (orderId: string) =>
  h.prisma.orderItem.findFirstOrThrow({ where: { orderId } });
const stockOf = (id: string) =>
  h.prisma.warehouseItem.findUniqueOrThrow({ where: { id } });

/** Закупка склада с qty@unitPrice; возвращает itemId. */
async function stockedItem(qty: string, unitPrice: string, name = 'Деталь A') {
  const itemId = await seedWarehouseItem(h.prisma, seed.workspaceId, name);
  await h.purchases.register(seed.workspaceId, seed.userId, {
    accountId: seed.accountId,
    lines: [{ warehouseItemId: itemId, qty, unitPrice }],
  });
  return itemId;
}

describe('Создание: нумерация и суммы', () => {
  it('первый заказ года получает ORD-YYYY-0001, второй — 0002', async () => {
    const year = new Date().getFullYear();
    const o1 = await h.orders.create(seed.workspaceId, {
      items: [{ name: 'Услуга', qty: '1', unitPrice: '100' }],
    });
    const o2 = await h.orders.create(seed.workspaceId, {
      items: [{ name: 'Услуга', qty: '1', unitPrice: '100' }],
    });
    expect(o1.number).toBe(`ORD-${year}-0001`);
    expect(o2.number).toBe(`ORD-${year}-0002`);
  });

  it('subtotal/discount/total и lineTotal считаются точно; статусы по умолчанию', async () => {
    const order = await h.orders.create(seed.workspaceId, {
      title: 'Сложный заказ',
      discountAmount: '150.50',
      items: [
        { name: 'A', qty: '2', unitPrice: '100.00' }, // 200.00
        { name: 'B', qty: '3', unitPrice: '49.99' }, // 149.97
      ],
    });
    // subtotal = 200 + 149.97 = 349.97
    expect(num(order.subtotal)).toBe(349.97);
    expect(num(order.discountAmount)).toBe(150.5);
    expect(num(order.totalAmount)).toBe(199.47); // 349.97 − 150.50
    expect(num(order.paidAmount)).toBe(0);
    expect(order.status).toBe('OPEN');
    expect(order.paymentStatus).toBe('UNPAID');
    expect(order.title).toBe('Сложный заказ');

    const items = await h.prisma.orderItem.findMany({
      where: { orderId: order.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(items.map((i) => num(i.lineTotal))).toEqual([200, 149.97]);
  });

  it('заказ без позиций: subtotal/total = 0', async () => {
    const order = await h.orders.create(seed.workspaceId, { items: [] });
    expect(num(order.subtotal)).toBe(0);
    expect(num(order.totalAmount)).toBe(0);
    expect((await h.prisma.orderItem.count({ where: { orderId: order.id } }))).toBe(0);
  });
});

describe('get / list', () => {
  it('get отдаёт заказ с позициями и транзакциями; несуществующий — throw', async () => {
    const order = await h.orders.create(seed.workspaceId, {
      items: [{ name: 'Услуга', qty: '1', unitPrice: '500' }],
    });
    await h.orders.addPayment(seed.workspaceId, order.id, seed.userId, {
      amount: '500',
      accountId: seed.accountId,
    });
    const got = await h.orders.get(seed.workspaceId, order.id);
    expect(got.items).toHaveLength(1);
    expect(got.transactions).toHaveLength(1);

    await expect(h.orders.get(seed.workspaceId, 'nonexistent-id')).rejects.toThrow();
  });

  it('list фильтрует по статусу и не показывает удалённые', async () => {
    const open = await h.orders.create(seed.workspaceId, {
      items: [{ name: 'Услуга', qty: '1', unitPrice: '100' }],
    });
    const toDelete = await h.orders.create(seed.workspaceId, {
      items: [{ name: 'Услуга', qty: '1', unitPrice: '100' }],
    });
    const done = await h.orders.create(seed.workspaceId, {
      items: [{ name: 'Услуга', qty: '1', unitPrice: '100' }],
    });
    await h.orders.finalize(seed.workspaceId, done.id, seed.userId);
    await h.orders.remove(seed.workspaceId, toDelete.id, seed.userId);

    const all = await h.orders.list(seed.workspaceId, {});
    expect(all.items.map((o) => o.id).sort()).toEqual([open.id, done.id].sort());
    expect(all.nextCursor).toBeNull();

    const onlyDone = await h.orders.list(seed.workspaceId, { status: 'DONE' });
    expect(onlyDone.items.map((o) => o.id)).toEqual([done.id]);
  });

  it('курсор-пагинация: limit отдаёт страницу + nextCursor, вторая страница добирает остаток', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const o = await h.orders.create(seed.workspaceId, {
        items: [{ name: `Поз ${i}`, qty: '1', unitPrice: '100' }],
      });
      ids.push(o.id);
    }
    const page1 = await h.orders.list(seed.workspaceId, { limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await h.orders.list(seed.workspaceId, { limit: 2, cursor: page1.nextCursor! });
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();

    // Все 3 заказа покрыты, без дублей между страницами.
    const seen = [...page1.items, ...page2.items].map((o) => o.id);
    expect(new Set(seen).size).toBe(3);
    expect(seen.sort()).toEqual([...ids].sort());
  });
});

describe('Обновление (update)', () => {
  it('замена позиций пересчитывает subtotal/total с учётом discount', async () => {
    const order = await h.orders.create(seed.workspaceId, {
      discountAmount: '50',
      items: [{ name: 'A', qty: '1', unitPrice: '100' }],
    });
    const updated = await h.orders.update(seed.workspaceId, order.id, {
      items: [
        { name: 'X', qty: '2', unitPrice: '300' },
        { name: 'Y', qty: '1', unitPrice: '400' },
      ],
    });
    // subtotal 600 + 400 = 1000, discount сохранён 50 → total 950
    expect(num(updated!.subtotal)).toBe(1000);
    expect(num(updated!.discountAmount)).toBe(50);
    expect(num(updated!.totalAmount)).toBe(950);
    const names = (await h.prisma.orderItem.findMany({ where: { orderId: order.id } }))
      .map((i) => i.name)
      .sort();
    expect(names).toEqual(['X', 'Y']);
  });

  it('изменение только discount пересчитывает total от старого subtotal', async () => {
    const order = await h.orders.create(seed.workspaceId, {
      items: [{ name: 'A', qty: '4', unitPrice: '250' }], // subtotal 1000
    });
    const updated = await h.orders.update(seed.workspaceId, order.id, {
      discountAmount: '300',
    });
    expect(num(updated!.subtotal)).toBe(1000);
    expect(num(updated!.discountAmount)).toBe(300);
    expect(num(updated!.totalAmount)).toBe(700);
  });

  it('update пересчитывает paymentStatus: после повышения total PAID→PARTIAL', async () => {
    const order = await h.orders.create(seed.workspaceId, {
      items: [{ name: 'A', qty: '1', unitPrice: '500' }],
    });
    await h.orders.addPayment(seed.workspaceId, order.id, seed.userId, {
      amount: '500',
      accountId: seed.accountId,
    });
    const paid = await h.orders.get(seed.workspaceId, order.id);
    expect(paid.paymentStatus).toBe('PAID');

    const updated = await h.orders.update(seed.workspaceId, order.id, {
      items: [{ name: 'A', qty: '1', unitPrice: '900' }],
    });
    expect(num(updated!.paidAmount)).toBe(500); // платёж не тронут
    expect(updated!.paymentStatus).toBe('PARTIAL'); // 500 < 900
  });

  it('гвард: нельзя редактировать DONE и CANCELLED', async () => {
    const done = await h.orders.create(seed.workspaceId, {
      items: [{ name: 'A', qty: '1', unitPrice: '100' }],
    });
    await h.orders.finalize(seed.workspaceId, done.id, seed.userId);
    await expect(
      h.orders.update(seed.workspaceId, done.id, { title: 'x' }),
    ).rejects.toThrow();

    const cancelled = await h.orders.create(seed.workspaceId, {
      items: [{ name: 'A', qty: '1', unitPrice: '100' }],
    });
    await h.orders.cancel(seed.workspaceId, cancelled.id, seed.userId);
    await expect(
      h.orders.update(seed.workspaceId, cancelled.id, { title: 'x' }),
    ).rejects.toThrow();
  });
});

describe('Оплата (addPayment) — гварды и состояние REFUNDED', () => {
  it('нельзя оплатить отменённый заказ', async () => {
    const order = await h.orders.create(seed.workspaceId, {
      items: [{ name: 'A', qty: '1', unitPrice: '100' }],
    });
    await h.orders.cancel(seed.workspaceId, order.id, seed.userId);
    await expect(
      h.orders.addPayment(seed.workspaceId, order.id, seed.userId, {
        amount: '100',
        accountId: seed.accountId,
      }),
    ).rejects.toThrow();
  });

  it('DE5: возврат больше собранного отклоняется (paidAmount не уходит в минус)', async () => {
    // Услуга: продано 1 за 1000, оплачено 1000, закрыто, затем RMA с refund > собранного.
    const order = await h.orders.create(seed.workspaceId, {
      items: [{ name: 'Услуга', qty: '1', unitPrice: '1000' }],
    });
    await h.orders.addPayment(seed.workspaceId, order.id, seed.userId, {
      amount: '1000',
      accountId: seed.accountId,
    });
    await h.orders.finalize(seed.workspaceId, order.id, seed.userId);
    const oi = await itemOf(order.id);
    // refund 1200 > собранное 1000 → 400 (кап DE5), paidAmount остаётся 1000.
    await expect(
      h.orders.returnItem(seed.workspaceId, order.id, seed.userId, {
        itemId: oi.id,
        returnQty: '1',
        refundAmount: '1200',
        accountId: seed.accountId,
      }),
    ).rejects.toThrow(/превышает собранную сумму/);
    const after = await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.paidAmount.toFixed(2)).toBe('1000.00');
    expect(after.paymentStatus).toBe('PAID');
  });

  it('DE5: возврат ровно собранного проходит (paidAmount → 0)', async () => {
    const order = await h.orders.create(seed.workspaceId, {
      items: [{ name: 'Услуга', qty: '1', unitPrice: '1000' }],
    });
    await h.orders.addPayment(seed.workspaceId, order.id, seed.userId, {
      amount: '1000',
      accountId: seed.accountId,
    });
    await h.orders.finalize(seed.workspaceId, order.id, seed.userId);
    const oi = await itemOf(order.id);
    const updated = await h.orders.returnItem(seed.workspaceId, order.id, seed.userId, {
      itemId: oi.id,
      returnQty: '1',
      refundAmount: '1000',
      accountId: seed.accountId,
    });
    expect(num(updated!.paidAmount)).toBe(0);
  });
});

describe('DE3/DE4: guard\'ы суммы и даты оплаты', () => {
  it('DE3: отрицательная/нулевая оплата отклоняется', async () => {
    const order = await h.orders.create(seed.workspaceId, {
      items: [{ name: 'Товар', qty: '1', unitPrice: '1000' }],
    });
    for (const bad of ['-15000', '0']) {
      await expect(
        h.orders.addPayment(seed.workspaceId, order.id, seed.userId, {
          amount: bad,
          accountId: seed.accountId,
        }),
      ).rejects.toThrow(/положительной/);
    }
    const after = await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.paymentStatus).toBe('UNPAID');
  });

  it('DE4: будущая дата оплаты отклоняется, прошлая — проходит', async () => {
    const order = await h.orders.create(seed.workspaceId, {
      items: [{ name: 'Товар', qty: '1', unitPrice: '1000' }],
    });
    await expect(
      h.orders.addPayment(seed.workspaceId, order.id, seed.userId, {
        amount: '500',
        accountId: seed.accountId,
        date: '2099-01-01T00:00:00.000Z',
      }),
    ).rejects.toThrow(/будущем/);
    // Прошлая дата — норма (бэкдейт вчерашнего платежа).
    await expect(
      h.orders.addPayment(seed.workspaceId, order.id, seed.userId, {
        amount: '500',
        accountId: seed.accountId,
        date: '2026-01-01T00:00:00.000Z',
      }),
    ).resolves.toBeTruthy();
  });
});

describe('Закрытие (finalize) — идемпотентность и гвард', () => {
  it('повторный finalize по DONE возвращает заказ без новых эффектов', async () => {
    const itemId = await stockedItem('20', '150');
    const order = await h.orders.create(seed.workspaceId, {
      items: [{ warehouseItemId: itemId, name: 'Деталь A', qty: '5', unitPrice: '500' }],
    });
    await h.orders.finalize(seed.workspaceId, order.id, seed.userId);
    expect(num((await stockOf(itemId)).qty)).toBe(15);

    const again = await h.orders.finalize(seed.workspaceId, order.id, seed.userId);
    expect(again?.status).toBe('DONE');
    // склад не списан повторно
    expect(num((await stockOf(itemId)).qty)).toBe(15);
    const saleCount = await h.prisma.stockMovement.count({
      where: { workspaceId: seed.workspaceId, warehouseItemId: itemId, type: 'SALE' },
    });
    expect(saleCount).toBe(1);
  });

  it('нельзя закрыть отменённый заказ', async () => {
    const order = await h.orders.create(seed.workspaceId, {
      items: [{ name: 'A', qty: '1', unitPrice: '100' }],
    });
    await h.orders.cancel(seed.workspaceId, order.id, seed.userId);
    await expect(
      h.orders.finalize(seed.workspaceId, order.id, seed.userId),
    ).rejects.toThrow();
  });

  it('finalize проставляет closedAt', async () => {
    const order = await h.orders.create(seed.workspaceId, {
      items: [{ name: 'A', qty: '1', unitPrice: '100' }],
    });
    const done = await h.orders.finalize(seed.workspaceId, order.id, seed.userId);
    expect(done?.closedAt).not.toBeNull();
  });
});

describe('Отмена (cancel) — идемпотентность', () => {
  it('повторная отмена не дублирует возврат склада', async () => {
    const itemId = await stockedItem('20', '150');
    const order = await h.orders.create(seed.workspaceId, {
      items: [{ warehouseItemId: itemId, name: 'Деталь A', qty: '5', unitPrice: '500' }],
    });
    await h.orders.finalize(seed.workspaceId, order.id, seed.userId);
    await h.orders.cancel(seed.workspaceId, order.id, seed.userId);
    expect(num((await stockOf(itemId)).qty)).toBe(20);

    const again = await h.orders.cancel(seed.workspaceId, order.id, seed.userId);
    expect(again?.status).toBe('CANCELLED');
    expect(num((await stockOf(itemId)).qty)).toBe(20); // не 25
  });

  it('cancel DONE-заказа с ручным COGS сторнирует COGS-расход', async () => {
    const order = await h.orders.create(seed.workspaceId, {
      items: [{ name: 'Работа', qty: '2', unitPrice: '1000', unitCost: '300' }],
    });
    await h.orders.addPayment(seed.workspaceId, order.id, seed.userId, {
      amount: '2000',
      accountId: seed.accountId,
    });
    await h.orders.finalize(seed.workspaceId, order.id, seed.userId);
    const cogsActive = await h.prisma.transaction.count({
      where: { orderId: order.id, kind: 'COGS', deletedAt: null },
    });
    expect(cogsActive).toBe(1);

    await h.orders.cancel(seed.workspaceId, order.id, seed.userId);
    const cogsAfter = await h.prisma.transaction.count({
      where: { orderId: order.id, kind: 'COGS', deletedAt: null },
    });
    expect(cogsAfter).toBe(0); // сторнирован (soft-delete)
    // платёж НЕ тронут при отмене
    const payActive = await h.prisma.transaction.count({
      where: { orderId: order.id, kind: 'ORDER_PAYMENT', deletedAt: null },
    });
    expect(payActive).toBe(1);
  });
});

describe('Переоткрытие (reopen)', () => {
  it('DONE → OPEN: возврат склада, сторно COGS, сброс shippedQty/closedAt, сохранение оплаты', async () => {
    const itemId = await stockedItem('20', '150');
    const order = await h.orders.create(seed.workspaceId, {
      items: [{ warehouseItemId: itemId, name: 'Деталь A', qty: '5', unitPrice: '500' }],
    });
    await h.orders.addPayment(seed.workspaceId, order.id, seed.userId, {
      amount: '2500',
      accountId: seed.accountId,
    });
    await h.orders.finalize(seed.workspaceId, order.id, seed.userId);
    expect(num((await stockOf(itemId)).qty)).toBe(15);

    const reopened = await h.orders.reopen(seed.workspaceId, order.id, seed.userId);
    expect(reopened?.status).toBe('OPEN');
    expect(reopened?.closedAt).toBeNull();
    // склад вернулся
    expect(num((await stockOf(itemId)).qty)).toBe(20);
    const oi = await itemOf(order.id);
    expect(num(oi.shippedQty)).toBe(0);
    expect(oi.unitCostAtSale).toBeNull();
    // оплата сохранена и пересчитана: 2500 на total 2500 → PAID
    expect(num(reopened!.paidAmount)).toBe(2500);
    expect(reopened!.paymentStatus).toBe('PAID');
  });

  it('reopen с ручным COGS сторнирует COGS-расход', async () => {
    const order = await h.orders.create(seed.workspaceId, {
      items: [{ name: 'Работа', qty: '2', unitPrice: '1000', unitCost: '300' }],
    });
    await h.orders.addPayment(seed.workspaceId, order.id, seed.userId, {
      amount: '2000',
      accountId: seed.accountId,
    });
    await h.orders.finalize(seed.workspaceId, order.id, seed.userId);

    await h.orders.reopen(seed.workspaceId, order.id, seed.userId);
    const cogsActive = await h.prisma.transaction.count({
      where: { orderId: order.id, kind: 'COGS', deletedAt: null },
    });
    expect(cogsActive).toBe(0);
  });

  it('CANCELLED → OPEN: статус меняется, оплата сохраняется', async () => {
    const order = await h.orders.create(seed.workspaceId, {
      items: [{ name: 'Услуга', qty: '1', unitPrice: '1000' }],
    });
    await h.orders.addPayment(seed.workspaceId, order.id, seed.userId, {
      amount: '400',
      accountId: seed.accountId,
    });
    await h.orders.cancel(seed.workspaceId, order.id, seed.userId);

    const reopened = await h.orders.reopen(seed.workspaceId, order.id, seed.userId);
    expect(reopened?.status).toBe('OPEN');
    expect(num(reopened!.paidAmount)).toBe(400);
    expect(reopened!.paymentStatus).toBe('PARTIAL');
  });

  it('после reopen заказ снова редактируем (DONE-гвард снят)', async () => {
    const order = await h.orders.create(seed.workspaceId, {
      items: [{ name: 'A', qty: '1', unitPrice: '100' }],
    });
    await h.orders.finalize(seed.workspaceId, order.id, seed.userId);
    await h.orders.reopen(seed.workspaceId, order.id, seed.userId);
    const updated = await h.orders.update(seed.workspaceId, order.id, { title: 'снова в работе' });
    expect(updated!.title).toBe('снова в работе');
  });

  it('гвард: нельзя reopen открытый заказ', async () => {
    const order = await h.orders.create(seed.workspaceId, {
      items: [{ name: 'A', qty: '1', unitPrice: '100' }],
    });
    await expect(
      h.orders.reopen(seed.workspaceId, order.id, seed.userId),
    ).rejects.toThrow();
  });
});

describe('Удаление (remove)', () => {
  it('soft-delete заказа + сторно ВСЕХ транзакций (платёж, COGS) и возврат склада', async () => {
    const itemId = await stockedItem('20', '150');
    const order = await h.orders.create(seed.workspaceId, {
      items: [{ warehouseItemId: itemId, name: 'Деталь A', qty: '5', unitPrice: '500' }],
    });
    await h.orders.addPayment(seed.workspaceId, order.id, seed.userId, {
      amount: '2500',
      accountId: seed.accountId,
    });
    await h.orders.finalize(seed.workspaceId, order.id, seed.userId);

    const res = await h.orders.remove(seed.workspaceId, order.id, seed.userId);
    expect(res).toEqual({ ok: true });

    // заказ soft-deleted: get не находит
    await expect(h.orders.get(seed.workspaceId, order.id)).rejects.toThrow();
    const raw = await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(raw.deletedAt).not.toBeNull();

    // склад вернулся
    expect(num((await stockOf(itemId)).qty)).toBe(20);
    // ВСЕ транзакции заказа сторнированы (в т.ч. платёж — в отличие от cancel)
    const active = await h.prisma.transaction.count({
      where: { orderId: order.id, deletedAt: null },
    });
    expect(active).toBe(0);
  });

  it('remove OPEN-заказа с возвратами сторнирует и платёж, и ORDER_REFUND', async () => {
    const order = await h.orders.create(seed.workspaceId, {
      items: [{ name: 'Услуга', qty: '2', unitPrice: '1000' }],
    });
    await h.orders.addPayment(seed.workspaceId, order.id, seed.userId, {
      amount: '2000',
      accountId: seed.accountId,
    });
    await h.orders.finalize(seed.workspaceId, order.id, seed.userId);
    const oi = await itemOf(order.id);
    await h.orders.returnItem(seed.workspaceId, order.id, seed.userId, {
      itemId: oi.id,
      returnQty: '1',
      refundAmount: '1000',
      accountId: seed.accountId,
    });
    // до удаления: платёж + COGS(нет, услуга без unitCost) + refund
    const before = await h.prisma.transaction.count({
      where: { orderId: order.id, deletedAt: null },
    });
    expect(before).toBeGreaterThanOrEqual(2);

    await h.orders.remove(seed.workspaceId, order.id, seed.userId);
    const after = await h.prisma.transaction.count({
      where: { orderId: order.id, deletedAt: null },
    });
    expect(after).toBe(0);
  });

  it('remove несуществующего заказа — throw', async () => {
    await expect(
      h.orders.remove(seed.workspaceId, 'nonexistent-id', seed.userId),
    ).rejects.toThrow();
  });
});

describe('Полный жизненный цикл (сквозной)', () => {
  it('создать → оплатить → отгрузить → закрыть → возврат → переоткрыть → удалить', async () => {
    const itemId = await stockedItem('20', '100'); // склад 20 @100
    const order = await h.orders.create(seed.workspaceId, {
      items: [{ warehouseItemId: itemId, name: 'Деталь A', qty: '10', unitPrice: '300' }],
    });
    const oi = await itemOf(order.id);

    // оплата 1500 из 3000 → PARTIAL
    let o = await h.orders.addPayment(seed.workspaceId, order.id, seed.userId, {
      amount: '1500',
      accountId: seed.accountId,
    });
    expect(o!.paymentStatus).toBe('PARTIAL');

    // частичная отгрузка 4 → склад 16, заказ OPEN
    await h.orders.ship(seed.workspaceId, order.id, seed.userId, { itemId: oi.id, qty: '4' });
    expect(num((await stockOf(itemId)).qty)).toBe(16);
    expect((await h.orders.get(seed.workspaceId, order.id)).status).toBe('OPEN');

    // закрытие отгружает остаток 6 → склад 10, DONE
    o = await h.orders.finalize(seed.workspaceId, order.id, seed.userId);
    expect(o!.status).toBe('DONE');
    expect(num((await stockOf(itemId)).qty)).toBe(10);
    expect(num((await itemOf(order.id)).shippedQty)).toBe(10);

    // возврат 3 с refund 900 → склад 13, paid 1500−900=600
    o = await h.orders.returnItem(seed.workspaceId, order.id, seed.userId, {
      itemId: oi.id,
      returnQty: '3',
      refundAmount: '900',
      accountId: seed.accountId,
    });
    expect(num((await stockOf(itemId)).qty)).toBe(13);
    expect(num(o!.paidAmount)).toBe(600);
    expect(o!.paymentStatus).toBe('PARTIAL');

    // переоткрытие: netOut = qty10 − returned3 = 7 на складе вернётся → 13+7=20
    o = await h.orders.reopen(seed.workspaceId, order.id, seed.userId);
    expect(o!.status).toBe('OPEN');
    expect(num((await stockOf(itemId)).qty)).toBe(20);
    expect(num((await itemOf(order.id)).shippedQty)).toBe(0);

    // удаление: soft-delete + сторно всех денег
    await h.orders.remove(seed.workspaceId, order.id, seed.userId);
    await expect(h.orders.get(seed.workspaceId, order.id)).rejects.toThrow();
    const activeTx = await h.prisma.transaction.count({
      where: { orderId: order.id, deletedAt: null },
    });
    expect(activeTx).toBe(0);
  });
});

describe('Трек B: изоляция арендатора и нумерация', () => {
  it('B1: addPayment с чужим счётом → ошибка (не садится на чужой workspace)', async () => {
    const other = await seedBase(h.prisma, tg + 700000n);
    const order = await h.orders.create(seed.workspaceId, {
      items: [{ name: 'Услуга', qty: '1', unitPrice: '100' }],
    });
    await expect(
      h.orders.addPayment(seed.workspaceId, order.id, seed.userId, {
        amount: '100',
        accountId: other.accountId, // счёт другого пространства
      }),
    ).rejects.toThrow();
    // платёж не создан
    expect(await h.prisma.transaction.count({ where: { orderId: order.id } })).toBe(0);
  });

  it('B4: create с чужим clientId → ошибка', async () => {
    const other = await seedBase(h.prisma, tg + 700001n);
    const foreignClient = await h.prisma.counterparty.create({
      data: { workspaceId: other.workspaceId, name: 'Чужой клиент', role: 'CLIENT' },
    });
    await expect(
      h.orders.create(seed.workspaceId, {
        clientId: foreignClient.id,
        items: [{ name: 'Услуга', qty: '1', unitPrice: '100' }],
      }),
    ).rejects.toThrow();
  });

  it('B4: create с чужой складской позицией → ошибка', async () => {
    const other = await seedBase(h.prisma, tg + 700002n);
    const foreignItemId = await seedWarehouseItem(h.prisma, other.workspaceId, 'Чужая деталь');
    await expect(
      h.orders.create(seed.workspaceId, {
        items: [{ warehouseItemId: foreignItemId, name: 'X', qty: '1', unitPrice: '100' }],
      }),
    ).rejects.toThrow();
  });

  it('B5: нумерация корректна после 9999 (числовой MAX, без регрессии к 10000)', async () => {
    const year = new Date().getFullYear();
    await h.prisma.order.create({
      data: { workspaceId: seed.workspaceId, number: `ORD-${year}-9999` },
    });
    const next = await h.orders.create(seed.workspaceId, { items: [] });
    expect(next.number).toBe(`ORD-${year}-10000`);
    const next2 = await h.orders.create(seed.workspaceId, { items: [] });
    expect(next2.number).toBe(`ORD-${year}-10001`);
  });
});
