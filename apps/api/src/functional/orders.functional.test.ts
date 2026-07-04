/**
 * Функциональные тесты мутаций заказов (Фаза 2.2 — «кнопка → HTTP → БД»).
 *
 * Через РЕАЛЬНЫЙ Nest+Fastify (buildHttpApp): JwtAuthGuard + WorkspaceGuard +
 * ZodPipe + AllExceptionsFilter — полный прод-пайплайн. На каждую мутацию:
 * запрос → проверка HTTP-кода → проверка ТОЧНЫХ последствий в БД через Prisma
 * (статусы, paidAmount, shippedQty/returnedQty, StockMovement, Transaction).
 *
 * Orders — самый сложный домен (9 мутирующих эндпоинтов):
 *   POST   /orders            — создать (subtotal/total/paidAmount пересчёт)
 *   PATCH  /orders/:id         — редактировать (replace items → пересчёт сумм)
 *   DELETE /orders/:id         — soft-delete + откат склада + сторно проводок
 *   POST   /orders/:id/payments   — оплата → Transaction(ORDER_PAYMENT/INCOME)
 *   POST   /orders/:id/ship       — частичная отгрузка → StockMovement SALE
 *   POST   /orders/:id/finalize   — выдача → DONE/closedAt + дотгрузка остатка
 *   POST   /orders/:id/returns    — возврат → restock + Transaction(ORDER_REFUND)
 *   POST   /orders/:id/cancel     — отмена → CANCELLED + откат склада
 *   POST   /orders/:id/reopen     — вернуть в работу → OPEN + откат склада
 *
 * Деньги — Decimal: сверяем через .toFixed(2). Для отгрузки/финализации нужен
 * склад с запасом — создаём позицию вместе с FIFO-партией через seedStockItem
 * (прямой create без партии не имел бы лотов для списания при ship/finalize).
 * Диапазон telegramId: 2500000n+ (не пересекается с другими сьютами).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildHttpApp, type HttpApp } from '../e2e/http-harness';
import { resetDb, seedBase, seedMember, seedStockItem, type Seed } from '../test/money-harness';

const num = (v: { toString(): string }) => Number(v.toString());

let H: HttpApp;
let seed: Seed;
let token: string;
let tg = 2500000n;

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

// ── Хелперы ─────────────────────────────────────────────────────────────────

interface OrderItemJson {
  id: string;
  qty: string;
  unitPrice: string;
  shippedQty: string;
  returnedQty: string;
}
interface OrderJson {
  id: string;
  number: string;
  status: string;
  paymentStatus: string;
  subtotal: string;
  totalAmount: string;
  paidAmount: string;
  closedAt: string | null;
  items: OrderItemJson[];
}

/**
 * Складская позиция с готовым остатком и себестоимостью, материализованным
 * FIFO-партией (OPENING-лот @avgCost). При единственной партии FIFO-списание идёт
 * по unitCost = avgCost, поэтому unitCostAtSale/COGS совпадают со старыми WAVG-ожиданиями.
 */
async function stockedItem(qty = '100', avgCost = '50', name = 'Деталь A'): Promise<string> {
  const { id } = await seedStockItem(H.prisma, {
    workspaceId: seed.workspaceId,
    createdById: seed.userId,
    name,
    qty,
    unitCost: avgCost,
  });
  return id;
}

/** Контрагент-клиент (для проверки привязки counterpartyId в проводках). */
async function client(name = 'ООО Клиент'): Promise<string> {
  const cp = await H.prisma.counterparty.create({
    data: { workspaceId: seed.workspaceId, name, role: 'CLIENT' },
  });
  return cp.id;
}

/** Создать заказ через РЕАЛЬНЫЙ POST /orders и вернуть распарсенный ответ. */
async function createOrder(payload: Record<string, unknown>): Promise<OrderJson> {
  const res = await H.inject({
    method: 'POST',
    url: `/workspaces/${seed.workspaceId}/orders`,
    token,
    payload,
  });
  expect(res.statusCode).toBe(201);
  return res.json<OrderJson>();
}

/** Типовой заказ: 1 складская позиция, qty=10 по 500 (итог 5000). */
async function orderWith(
  warehouseItemId: string,
  qty = '10',
  unitPrice = '500',
  extra: Record<string, unknown> = {},
): Promise<OrderJson> {
  return createOrder({
    title: 'Заказ',
    items: [{ warehouseItemId, name: 'Деталь A', qty, unitPrice }],
    ...extra,
  });
}

// ── Тесты ─────────────────────────────────────────────────────────────────

describe('Функциональные мутации: заказы (orders)', () => {
  // ─── 1. POST /orders ───────────────────────────────────────────────────────
  it('POST /orders → 201, создаёт Order(OPEN/UNPAID) + OrderItem с пересчётом сумм', async () => {
    const ws = seed.workspaceId;
    const item = await stockedItem();
    const cl = await client();

    const order = await orderWith(item, '10', '500', { clientId: cl, discountAmount: '500' });

    expect(order.status).toBe('OPEN');
    expect(order.paymentStatus).toBe('UNPAID');

    const row = await H.prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true },
    });
    expect(row.workspaceId).toBe(ws);
    expect(row.clientId).toBe(cl);
    expect(row.number).toBeTruthy();
    expect(row.subtotal.toFixed(2)).toBe('5000.00');
    expect(row.discountAmount.toFixed(2)).toBe('500.00');
    expect(row.totalAmount.toFixed(2)).toBe('4500.00'); // subtotal − discount
    expect(row.paidAmount.toFixed(2)).toBe('0.00');
    expect(row.closedAt).toBeNull();
    expect(row.deletedAt).toBeNull();

    expect(row.items.length).toBe(1);
    const it = row.items[0]!;
    expect(it.warehouseItemId).toBe(item);
    expect(num(it.qty)).toBe(10);
    expect(it.unitPrice.toFixed(2)).toBe('500.00');
    expect(it.lineTotal.toFixed(2)).toBe('5000.00');
    expect(num(it.shippedQty)).toBe(0);
    expect(num(it.returnedQty)).toBe(0);

    // Создание заказа склад НЕ трогает (списание — только отгрузка/финализация).
    const wh = await H.prisma.warehouseItem.findUniqueOrThrow({ where: { id: item } });
    expect(num(wh.qty)).toBe(100);
  });

  it('POST /orders → 400 на невалидной позиции (пустое name), заказ не создаётся', async () => {
    const ws = seed.workspaceId;
    const before = await H.prisma.order.count({ where: { workspaceId: ws } });
    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/orders`,
      token,
      payload: { items: [{ name: '', qty: '1', unitPrice: '10' }] },
    });
    expect(res.statusCode).toBe(400);
    const after = await H.prisma.order.count({ where: { workspaceId: ws } });
    expect(after).toBe(before);
  });

  // ─── R5: валидация скидки заказа ───────────────────────────────────────────
  it('POST /orders → 400 при отрицательной скидке (R5a), заказ не создаётся', async () => {
    const ws = seed.workspaceId;
    const item = await stockedItem();
    const before = await H.prisma.order.count({ where: { workspaceId: ws } });

    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/orders`,
      token,
      payload: {
        items: [{ warehouseItemId: item, name: 'Деталь A', qty: '10', unitPrice: '500' }],
        discountAmount: '-100', // отрицательная скидка раздула бы total
      },
    });
    expect(res.statusCode).toBe(400);
    const after = await H.prisma.order.count({ where: { workspaceId: ws } });
    expect(after).toBe(before);
  });

  it('POST /orders → 400 при скидке больше суммы позиций (R5b), заказ не создаётся', async () => {
    const ws = seed.workspaceId;
    const item = await stockedItem();
    const before = await H.prisma.order.count({ where: { workspaceId: ws } });

    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/orders`,
      token,
      payload: {
        items: [{ warehouseItemId: item, name: 'Деталь A', qty: '10', unitPrice: '500' }], // subtotal 5000
        discountAmount: '5001', // > subtotal → total < 0
      },
    });
    expect(res.statusCode).toBe(400);
    const after = await H.prisma.order.count({ where: { workspaceId: ws } });
    expect(after).toBe(before);
  });

  it('POST /orders → 201 при валидной скидке (0 < discount < subtotal), totalAmount = subtotal − discount', async () => {
    const item = await stockedItem();
    const order = await orderWith(item, '10', '500', { discountAmount: '1500' }); // subtotal 5000

    const row = await H.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.subtotal.toFixed(2)).toBe('5000.00');
    expect(row.discountAmount.toFixed(2)).toBe('1500.00');
    expect(row.totalAmount.toFixed(2)).toBe('3500.00');
  });

  it('PATCH /orders/:id → 400 при отрицательной скидке (R5a), суммы не меняются', async () => {
    const ws = seed.workspaceId;
    const item = await stockedItem();
    const order = await orderWith(item, '10', '500'); // subtotal/total 5000

    const res = await H.inject({
      method: 'PATCH',
      url: `/workspaces/${ws}/orders/${order.id}`,
      token,
      payload: { discountAmount: '-100' },
    });
    expect(res.statusCode).toBe(400);

    const row = await H.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.totalAmount.toFixed(2)).toBe('5000.00');
    expect(row.discountAmount.toFixed(2)).toBe('0.00');
  });

  it('PATCH /orders/:id → 400 при скидке больше суммы позиций (R5b), суммы не меняются', async () => {
    const ws = seed.workspaceId;
    const item = await stockedItem();
    const order = await orderWith(item, '10', '500'); // subtotal 5000

    const res = await H.inject({
      method: 'PATCH',
      url: `/workspaces/${ws}/orders/${order.id}`,
      token,
      payload: { discountAmount: '5001' }, // > subtotal
    });
    expect(res.statusCode).toBe(400);

    const row = await H.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.totalAmount.toFixed(2)).toBe('5000.00');
    expect(row.discountAmount.toFixed(2)).toBe('0.00');
  });

  // ─── 2. PATCH /orders/:id ──────────────────────────────────────────────────
  it('PATCH /orders/:id → 200, обновляет поля и заменяет позиции с пересчётом', async () => {
    const item = await stockedItem();
    const order = await orderWith(item, '10', '500'); // итог 5000
    const ws = seed.workspaceId;

    const res = await H.inject({
      method: 'PATCH',
      url: `/workspaces/${ws}/orders/${order.id}`,
      token,
      payload: {
        title: 'Новый тайтл',
        items: [{ warehouseItemId: item, name: 'Деталь A', qty: '3', unitPrice: '200' }],
      },
    });
    expect(res.statusCode).toBe(200);

    const row = await H.prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true },
    });
    expect(row.title).toBe('Новый тайтл');
    // Позиции заменены целиком (delete+recreate) → пересчёт сумм: 3·200 = 600.
    expect(row.items.length).toBe(1);
    expect(num(row.items[0]!.qty)).toBe(3);
    expect(row.subtotal.toFixed(2)).toBe('600.00');
    expect(row.totalAmount.toFixed(2)).toBe('600.00');
    // Старая позиция удалена (deleteMany) — новый id.
    expect(row.items[0]!.id).not.toBe(order.items[0]!.id);
  });

  // ─── 3. DELETE /orders/:id ─────────────────────────────────────────────────
  it('DELETE /orders/:id → 200, soft-delete + откат склада + сторно проводок', async () => {
    const ws = seed.workspaceId;
    const item = await stockedItem('100', '50');
    const order = await orderWith(item, '10', '500');
    const itemId = order.items[0]!.id;

    // Отгружаем 4 (склад 100 → 96) и принимаем оплату (создаётся проводка).
    await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/orders/${order.id}/ship`,
      token,
      payload: { itemId, qty: '4' },
    });
    await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/orders/${order.id}/payments`,
      token,
      payload: { amount: '1000', accountId: seed.accountId },
    });

    const res = await H.inject({
      method: 'DELETE',
      url: `/workspaces/${ws}/orders/${order.id}`,
      token,
    });
    expect(res.statusCode).toBe(200); // ВНИМАНИЕ: 200 + {ok:true}, НЕ 204 (ср. accounts)
    expect(res.json<{ ok: boolean }>().ok).toBe(true);

    const row = await H.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.deletedAt).not.toBeNull();

    // Отгруженное вернулось на склад: 96 → 100.
    const wh = await H.prisma.warehouseItem.findUniqueOrThrow({ where: { id: item } });
    expect(num(wh.qty)).toBe(100);

    // Все проводки заказа сторнированы (soft-delete).
    const liveTx = await H.prisma.transaction.count({
      where: { workspaceId: ws, orderId: order.id, deletedAt: null },
    });
    expect(liveTx).toBe(0);
  });

  // ─── 4. POST /orders/:id/payments ──────────────────────────────────────────
  it('POST /orders/:id/payments → 200, Transaction(ORDER_PAYMENT/INCOME) + paidAmount/статус', async () => {
    const ws = seed.workspaceId;
    const item = await stockedItem();
    const cl = await client();
    const order = await orderWith(item, '10', '500', { clientId: cl }); // итог 5000

    // Платёж 3000 → PARTIAL.
    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/orders/${order.id}/payments`,
      token,
      payload: { amount: '3000', accountId: seed.accountId },
    });
    expect(res.statusCode).toBe(200);
    const paid = res.json<OrderJson>();
    expect(num(paid.paidAmount)).toBe(3000);
    expect(paid.paymentStatus).toBe('PARTIAL');

    const tx = await H.prisma.transaction.findFirstOrThrow({
      where: { workspaceId: ws, orderId: order.id, kind: 'ORDER_PAYMENT' },
    });
    expect(tx.type).toBe('INCOME');
    expect(tx.amount.toFixed(2)).toBe('3000.00');
    expect(tx.accountId).toBe(seed.accountId);
    expect(tx.counterpartyId).toBe(cl); // привязка к клиенту заказа

    // Добор до полной суммы → PAID.
    const res2 = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/orders/${order.id}/payments`,
      token,
      payload: { amount: '2000', accountId: seed.accountId },
    });
    expect(res2.statusCode).toBe(200);
    const fully = res2.json<OrderJson>();
    expect(num(fully.paidAmount)).toBe(5000);
    expect(fully.paymentStatus).toBe('PAID');

    const dbOrder = await H.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(dbOrder.paidAmount.toFixed(2)).toBe('5000.00');
    expect(dbOrder.paymentStatus).toBe('PAID');
  });

  it('POST /orders/:id/payments → 400 при счёте чужого workspace, проводка не создаётся', async () => {
    const ws = seed.workspaceId;
    const item = await stockedItem();
    const order = await orderWith(item);

    // Счёт другого workspace.
    const otherUser = await H.prisma.user.create({
      data: { telegramId: tg + 700000n, username: 'oth', firstName: 'O' },
    });
    const otherWs = await H.prisma.workspace.create({
      data: { name: 'Чужой', ownerId: otherUser.id },
    });
    const foreignAcc = await H.prisma.account.create({
      data: { workspaceId: otherWs.id, name: 'Чужой счёт', type: 'CASH' },
    });

    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/orders/${order.id}/payments`,
      token,
      payload: { amount: '100', accountId: foreignAcc.id },
    });
    expect(res.statusCode).toBe(400);
    const txCount = await H.prisma.transaction.count({
      where: { workspaceId: ws, orderId: order.id },
    });
    expect(txCount).toBe(0);
  });

  // ─── 5. POST /orders/:id/ship ──────────────────────────────────────────────
  it('POST /orders/:id/ship → 200, shippedQty += qty, списывает склад (StockMovement SALE)', async () => {
    const ws = seed.workspaceId;
    const item = await stockedItem('100', '50');
    const order = await orderWith(item, '10', '500');
    const itemId = order.items[0]!.id;

    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/orders/${order.id}/ship`,
      token,
      payload: { itemId, qty: '4' },
    });
    expect(res.statusCode).toBe(200);
    const shipped = res.json<OrderJson>();
    expect(shipped.status).toBe('OPEN'); // отгрузка не закрывает заказ
    expect(num(shipped.items.find((i) => i.id === itemId)!.shippedQty)).toBe(4);

    // Склад 100 → 96.
    const wh = await H.prisma.warehouseItem.findUniqueOrThrow({ where: { id: item } });
    expect(num(wh.qty)).toBe(96);

    // Движение склада SALE на −4 (refType=Order, refId=orderId, unitCost=avgCost).
    const mv = await H.prisma.stockMovement.findFirstOrThrow({
      where: { workspaceId: ws, warehouseItemId: item, type: 'SALE' },
    });
    expect(num(mv.qtyDelta)).toBe(-4);
    expect(num(mv.qtyAfter)).toBe(96);
    expect(mv.refType).toBe('Order');
    expect(mv.refId).toBe(order.id);
    expect(num(mv.unitCost!)).toBe(50);

    const dbItem = await H.prisma.orderItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(num(dbItem.shippedQty)).toBe(4);
    expect(num(dbItem.unitCostAtSale!)).toBe(50); // снапшот себестоимости для маржи
  });

  it('POST /orders/:id/ship → 400 при нехватке склада (НЕ 500), склад не списан', async () => {
    const ws = seed.workspaceId;
    const item = await stockedItem('5', '50'); // на складе всего 5
    const order = await orderWith(item, '10', '500'); // в заказе 10
    const itemId = order.items[0]!.id;

    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/orders/${order.id}/ship`,
      token,
      payload: { itemId, qty: '10' }, // <= остатка позиции (10), но > склада (5)
    });
    expect(res.statusCode).toBe(400); // InsufficientStock → BadRequest (LT-1)

    // Rollback: склад не тронут, отгрузка не зафиксирована.
    const wh = await H.prisma.warehouseItem.findUniqueOrThrow({ where: { id: item } });
    expect(num(wh.qty)).toBe(5);
    const dbItem = await H.prisma.orderItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(num(dbItem.shippedQty)).toBe(0);
  });

  it('POST /orders/:id/ship → 400 при отгрузке больше остатка позиции', async () => {
    const ws = seed.workspaceId;
    const item = await stockedItem('100', '50');
    const order = await orderWith(item, '10', '500');
    const itemId = order.items[0]!.id;

    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/orders/${order.id}/ship`,
      token,
      payload: { itemId, qty: '11' }, // > qty позиции (10)
    });
    expect(res.statusCode).toBe(400);
  });

  // ─── 6. POST /orders/:id/finalize ──────────────────────────────────────────
  it('POST /orders/:id/finalize → 200, DONE/closedAt, дотгрузка остатка, склад списан', async () => {
    const ws = seed.workspaceId;
    const item = await stockedItem('100', '50');
    const order = await orderWith(item, '10', '500');
    const itemId = order.items[0]!.id;

    // Сначала частично отгружаем 4 (склад 100 → 96), затем финализируем.
    await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/orders/${order.id}/ship`,
      token,
      payload: { itemId, qty: '4' },
    });

    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/orders/${order.id}/finalize`,
      token,
      // finalize — POST БЕЗ тела.
    });
    expect(res.statusCode).toBe(200);
    const fin = res.json<OrderJson>();
    expect(fin.status).toBe('DONE');
    expect(num(fin.items.find((i) => i.id === itemId)!.shippedQty)).toBe(10);

    const row = await H.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.status).toBe('DONE');
    expect(row.closedAt).not.toBeNull();

    // Дотгружен остаток 6 (96 → 90).
    const wh = await H.prisma.warehouseItem.findUniqueOrThrow({ where: { id: item } });
    expect(num(wh.qty)).toBe(90);

    const dbItem = await H.prisma.orderItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(num(dbItem.shippedQty)).toBe(10);
    expect(num(dbItem.unitCostAtSale!)).toBe(50);
  });

  it('POST /orders/:id/finalize → 400 при нехватке склада (НЕ 500), заказ остаётся OPEN', async () => {
    const ws = seed.workspaceId;
    const item = await stockedItem('5', '50'); // склада 5
    const order = await orderWith(item, '10', '500'); // нужно 10

    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/orders/${order.id}/finalize`,
      token,
    });
    expect(res.statusCode).toBe(400); // InsufficientStock → BadRequest (LT-1)

    // Rollback: статус OPEN, склад не тронут.
    const row = await H.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.status).toBe('OPEN');
    expect(row.closedAt).toBeNull();
    const wh = await H.prisma.warehouseItem.findUniqueOrThrow({ where: { id: item } });
    expect(num(wh.qty)).toBe(5);
  });

  // ─── 7. POST /orders/:id/returns ───────────────────────────────────────────
  it('POST /orders/:id/returns → 200, returnedQty += qty, restock + Transaction(ORDER_REFUND)', async () => {
    const ws = seed.workspaceId;
    const item = await stockedItem('100', '50');
    const cl = await client();
    const order = await orderWith(item, '10', '500', { clientId: cl }); // итог 5000
    const itemId = order.items[0]!.id;

    // Оплата 5000 (PAID) → финализация (DONE, склад 100 → 90).
    await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/orders/${order.id}/payments`,
      token,
      payload: { amount: '5000', accountId: seed.accountId },
    });
    await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/orders/${order.id}/finalize`,
      token,
    });

    // Возврат 2 шт с рефандом 1000.
    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/orders/${order.id}/returns`,
      token,
      payload: { itemId, returnQty: '2', refundAmount: '1000', accountId: seed.accountId },
    });
    expect(res.statusCode).toBe(200);
    const ret = res.json<OrderJson>();
    expect(num(ret.items.find((i) => i.id === itemId)!.returnedQty)).toBe(2);

    // Возврат на склад: 90 → 92.
    const wh = await H.prisma.warehouseItem.findUniqueOrThrow({ where: { id: item } });
    expect(num(wh.qty)).toBe(92);

    // Рефанд = ORDER_REFUND / EXPENSE на 1000.
    const refund = await H.prisma.transaction.findFirstOrThrow({
      where: { workspaceId: ws, orderId: order.id, kind: 'ORDER_REFUND' },
    });
    expect(refund.type).toBe('EXPENSE');
    expect(refund.amount.toFixed(2)).toBe('1000.00');
    expect(refund.counterpartyId).toBe(cl);

    // paidAmount = 5000 − 1000 = 4000. DE1: статус по чистой выручке — вернули
    // 2×500=1000, netRevenue = 5000 − 1000 = 4000 = paid → PAID (клиент оплатил
    // ровно то, что оставил; фантомного PARTIAL нет).
    const row = await H.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.paidAmount.toFixed(2)).toBe('4000.00');
    expect(row.paymentStatus).toBe('PAID');
    const dbItem = await H.prisma.orderItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(num(dbItem.returnedQty)).toBe(2);
  });

  it('POST /orders/:id/returns → 400 по незакрытому (OPEN) заказу', async () => {
    const ws = seed.workspaceId;
    const item = await stockedItem('100', '50');
    const order = await orderWith(item, '10', '500'); // остаётся OPEN
    const itemId = order.items[0]!.id;

    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/orders/${order.id}/returns`,
      token,
      payload: { itemId, returnQty: '1', refundAmount: '0', accountId: seed.accountId },
    });
    expect(res.statusCode).toBe(400); // возврат только по DONE
  });

  // ─── 8. POST /orders/:id/cancel ────────────────────────────────────────────
  it('POST /orders/:id/cancel → 200, CANCELLED + откат отгруженного склада', async () => {
    const ws = seed.workspaceId;
    const item = await stockedItem('100', '50');
    const order = await orderWith(item, '10', '500');
    const itemId = order.items[0]!.id;

    // Частичная отгрузка 4 (склад 100 → 96).
    await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/orders/${order.id}/ship`,
      token,
      payload: { itemId, qty: '4' },
    });

    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/orders/${order.id}/cancel`,
      token,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<OrderJson>().status).toBe('CANCELLED');

    const row = await H.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.status).toBe('CANCELLED');

    // Отгруженное вернулось: 96 → 100; shippedQty сброшен.
    const wh = await H.prisma.warehouseItem.findUniqueOrThrow({ where: { id: item } });
    expect(num(wh.qty)).toBe(100);
    const dbItem = await H.prisma.orderItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(num(dbItem.shippedQty)).toBe(0);
  });

  // ─── 9. POST /orders/:id/reopen ────────────────────────────────────────────
  it('POST /orders/:id/reopen → 200, DONE→OPEN, closedAt=null, откат склада', async () => {
    const ws = seed.workspaceId;
    const item = await stockedItem('100', '50');
    const order = await orderWith(item, '10', '500');
    const itemId = order.items[0]!.id;

    // Финализируем (DONE, склад 100 → 90), затем возвращаем в работу.
    await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/orders/${order.id}/finalize`,
      token,
    });

    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/orders/${order.id}/reopen`,
      token,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<OrderJson>().status).toBe('OPEN');

    const row = await H.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.status).toBe('OPEN');
    expect(row.closedAt).toBeNull();

    // Списанное при финализации вернулось: 90 → 100; shippedQty сброшен.
    const wh = await H.prisma.warehouseItem.findUniqueOrThrow({ where: { id: item } });
    expect(num(wh.qty)).toBe(100);
    const dbItem = await H.prisma.orderItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(num(dbItem.shippedQty)).toBe(0);
  });

  it('POST /orders/:id/reopen → 400 по заказу в работе (OPEN)', async () => {
    const ws = seed.workspaceId;
    const item = await stockedItem('100', '50');
    const order = await orderWith(item); // OPEN

    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/orders/${order.id}/reopen`,
      token,
    });
    expect(res.statusCode).toBe(400); // reopen только из DONE/CANCELLED
  });

  // ─── Общие негативы изоляции ───────────────────────────────────────────────
  it('негатив: 401 без токена и 403 к чужому workspace', async () => {
    const ws = seed.workspaceId;
    const noAuth = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/orders`,
      payload: { items: [] },
    });
    expect(noAuth.statusCode).toBe(401);

    const otherWs = await H.prisma.workspace.create({
      data: {
        name: 'Чужой',
        owner: { create: { telegramId: tg + 500000n, username: 'other', firstName: 'O' } },
      },
    });
    const forbidden = await H.inject({
      method: 'POST',
      url: `/workspaces/${otherWs.id}/orders`,
      token,
      payload: { items: [] },
    });
    expect(forbidden.statusCode).toBe(403);
  });
});
