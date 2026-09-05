/**
 * Функциональные тесты экрана «Входящие» (Ф1-C2) — критерий приёмки Ф1:
 * полный цикл на FakeBank «синк → строки в Inbox → разбор в проводку/оплату
 * заказа/dismiss → undo». Через реальный Nest+Fastify.
 *
 * Диапазон telegramId: 2700000n+.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Prisma, Role } from '@prisma/client';
import { buildHttpApp, type HttpApp } from '../e2e/http-harness';
import { resetDb, seedBase, seedMember, type Seed } from '../test/money-harness';

let H: HttpApp;
let seed: Seed;
let token: string;
let tg = 2700000n;

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
  await seedMember(H.prisma, seed.workspaceId, seed.userId, Role.OWNER);
  token = await H.jwtFor(seed.userId, tg);
});

const ws = () => seed.workspaceId;
const inbox = () => `/workspaces/${ws()}/inbox`;

/** Создаёт подключение и синкает FakeBank (4 строки в NEW). Возвращает connId. */
async function seedInbox(): Promise<string> {
  const create = await H.inject({
    method: 'POST',
    url: `/workspaces/${ws()}/integrations`,
    token,
    payload: {
      provider: 'ALFA',
      accountId: seed.accountId,
      token: 'tok-1234',
      accountNumber: '40802810401300015422',
    },
  });
  const connId = create.json<{ id: string }>().id;
  await H.inject({ method: 'POST', url: `/workspaces/${ws()}/integrations/${connId}/sync`, token });
  return connId;
}

/** Строка по externalId. */
async function lineByExt(connId: string, ext: string) {
  return H.prisma.bankStatementLine.findFirstOrThrow({
    where: { connectionId: connId, externalId: ext },
  });
}

describe('Входящие (Inbox): полный цикл разбора (Ф1-C2)', () => {
  it('GET /inbox и /count отдают 4 строки NEW после синка', async () => {
    const connId = await seedInbox();
    const list = await H.inject({ method: 'GET', url: inbox(), token });
    expect(list.statusCode).toBe(200);
    const body = list.json<{ items: unknown[]; nextCursor: string | null }>();
    expect(body.items).toHaveLength(4);

    const count = await H.inject({ method: 'GET', url: `${inbox()}/count`, token });
    expect(count.json<{ count: number }>().count).toBe(4);
    void connId;
  });

  it('categorize → создаёт проводку (kind OTHER) и переводит строку в RESOLVED', async () => {
    const connId = await seedInbox();
    const line = await lineByExt(connId, 'fake-3'); // расход «Аренда офиса» 8000
    const cat = await H.prisma.category.create({
      data: { workspaceId: ws(), name: 'Аренда', kind: 'EXPENSE', bucket: 'FIXED' },
    });

    const res = await H.inject({
      method: 'POST',
      url: `${inbox()}/${line.id}/categorize`,
      token,
      payload: { categoryId: cat.id },
    });
    expect(res.statusCode).toBe(200);

    const updated = await H.prisma.bankStatementLine.findUniqueOrThrow({ where: { id: line.id } });
    expect(updated.status).toBe('RESOLVED');
    expect(updated.transactionId).not.toBeNull();

    const tx = await H.prisma.transaction.findUniqueOrThrow({ where: { id: updated.transactionId! } });
    expect(tx.type).toBe('EXPENSE');
    expect(tx.kind).toBe('OTHER');
    expect(tx.amount.toString()).toBe('8000');
    expect(tx.categoryId).toBe(cat.id);
    expect(tx.accountId).toBe(seed.accountId);
  });

  it('attach-order → оплата заказа (ORDER_PAYMENT), paidAmount пересчитан', async () => {
    const connId = await seedInbox();
    const income = await lineByExt(connId, 'fake-1'); // приход 15000
    const order = await H.prisma.order.create({
      data: {
        workspaceId: ws(),
        number: 'ORD-INBOX-1',
        status: 'OPEN',
        subtotal: new Prisma.Decimal('15000'),
        totalAmount: new Prisma.Decimal('15000'),
        items: { create: [{ name: 'Товар', qty: '1', unitPrice: '15000', lineTotal: '15000' }] },
      },
    });

    const res = await H.inject({
      method: 'POST',
      url: `${inbox()}/${income.id}/attach-order`,
      token,
      payload: { orderId: order.id },
    });
    expect(res.statusCode).toBe(200);

    const pay = await H.prisma.transaction.findFirstOrThrow({
      where: { workspaceId: ws(), orderId: order.id, kind: 'ORDER_PAYMENT' },
    });
    expect(pay.amount.toString()).toBe('15000');
    const updatedOrder = await H.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(updatedOrder.paidAmount.toString()).toBe('15000');
    const updatedLine = await H.prisma.bankStatementLine.findUniqueOrThrow({ where: { id: income.id } });
    expect(updatedLine.status).toBe('RESOLVED');
    expect(updatedLine.transactionId).toBe(pay.id); // провенанс
  });

  it('удаление оплаты в карточке заказа возвращает строку во «Входящие»', async () => {
    // Живой случай: платёж привязали к заказу, потом сняли, чтобы перепривязать
    // как рассрочку. Строка оставалась RESOLVED со ссылкой на удалённую
    // проводку: во «Входящих» её нет, в остатке счёта денег нет, а вытащить
    // нечем — undo требовал живой проводки и отказывал.
    const connId = await seedInbox();
    const income = await lineByExt(connId, 'fake-1'); // приход 15000
    const order = await H.prisma.order.create({
      data: {
        workspaceId: ws(),
        number: 'ORD-INBOX-RETURN',
        status: 'OPEN',
        subtotal: new Prisma.Decimal('15000'),
        totalAmount: new Prisma.Decimal('15000'),
        items: { create: [{ name: 'Товар', qty: '1', unitPrice: '15000', lineTotal: '15000' }] },
      },
    });

    await H.inject({
      method: 'POST',
      url: `${inbox()}/${income.id}/attach-order`,
      token,
      payload: { orderId: order.id },
    });
    const pay = await H.prisma.transaction.findFirstOrThrow({
      where: { workspaceId: ws(), orderId: order.id, kind: 'ORDER_PAYMENT' },
    });

    const del = await H.inject({
      method: 'DELETE',
      url: `/workspaces/${ws()}/orders/${order.id}/payments/${pay.id}`,
      token,
    });
    expect(del.statusCode).toBe(200);

    const line = await H.prisma.bankStatementLine.findUniqueOrThrow({ where: { id: income.id } });
    expect(line.status).toBe('NEW');
    expect(line.transactionId).toBeNull();
    const back = await H.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(back.paidAmount.toString()).toBe('0');
  });

  it('undo строки, чья проводка уже удалена, возвращает её на разбор', async () => {
    // Страховка для строк, застрявших до предыдущего исправления: проводки нет,
    // а строка при ней. Отменять нечего — просто вернуть во «Входящие».
    const connId = await seedInbox();
    const income = await lineByExt(connId, 'fake-2');
    const cat = await H.prisma.category.create({
      data: { workspaceId: ws(), name: 'Прочий доход', kind: 'INCOME', bucket: 'OTHER' },
    });
    const res = await H.inject({
      method: 'POST',
      url: `${inbox()}/${income.id}/categorize`,
      token,
      payload: { categoryId: cat.id },
    });
    expect(res.statusCode).toBe(200);
    const line = await H.prisma.bankStatementLine.findUniqueOrThrow({ where: { id: income.id } });
    // Имитируем застрявшее состояние: проводка удалена, ссылка осталась.
    await H.prisma.transaction.update({
      where: { id: line.transactionId! },
      data: { deletedAt: new Date() },
    });

    const undo = await H.inject({ method: 'POST', url: `${inbox()}/${income.id}/undo`, token, payload: {} });
    expect(undo.statusCode).toBe(200);
    const after = await H.prisma.bankStatementLine.findUniqueOrThrow({ where: { id: income.id } });
    expect(after.status).toBe('NEW');
    expect(after.transactionId).toBeNull();
  });

  it('attach-order расхода → 400 (к заказу только приход)', async () => {
    const connId = await seedInbox();
    const expense = await lineByExt(connId, 'fake-3');
    const order = await H.prisma.order.create({
      data: {
        workspaceId: ws(),
        number: 'ORD-INBOX-2',
        status: 'OPEN',
        subtotal: new Prisma.Decimal('100'),
        totalAmount: new Prisma.Decimal('100'),
        items: { create: [{ name: 'T', qty: '1', unitPrice: '100', lineTotal: '100' }] },
      },
    });
    const res = await H.inject({
      method: 'POST',
      url: `${inbox()}/${expense.id}/attach-order`,
      token,
      payload: { orderId: order.id },
    });
    expect(res.statusCode).toBe(400);
  });

  it('dismiss → строка DISMISSED, из Inbox уходит', async () => {
    const connId = await seedInbox();
    const line = await lineByExt(connId, 'fake-4');
    const res = await H.inject({ method: 'POST', url: `${inbox()}/${line.id}/dismiss`, token });
    expect(res.statusCode).toBe(200);
    const updated = await H.prisma.bankStatementLine.findUniqueOrThrow({ where: { id: line.id } });
    expect(updated.status).toBe('DISMISSED');
    const count = await H.inject({ method: 'GET', url: `${inbox()}/count`, token });
    expect(count.json<{ count: number }>().count).toBe(3);
  });

  it('undo категоризованной строки → проводка снята, строка снова NEW', async () => {
    const connId = await seedInbox();
    const line = await lineByExt(connId, 'fake-2');
    const cat = await H.prisma.category.create({
      data: { workspaceId: ws(), name: 'Комиссии', kind: 'EXPENSE', bucket: 'VARIABLE' },
    });
    await H.inject({
      method: 'POST',
      url: `${inbox()}/${line.id}/categorize`,
      token,
      payload: { categoryId: cat.id },
    });
    const resolved = await H.prisma.bankStatementLine.findUniqueOrThrow({ where: { id: line.id } });
    const txId = resolved.transactionId!;

    const undo = await H.inject({ method: 'POST', url: `${inbox()}/${line.id}/undo`, token });
    expect(undo.statusCode).toBe(200);

    const back = await H.prisma.bankStatementLine.findUniqueOrThrow({ where: { id: line.id } });
    expect(back.status).toBe('NEW');
    expect(back.transactionId).toBeNull();
    const tx = await H.prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(tx.deletedAt).not.toBeNull(); // проводка soft-deleted
  });

  it('undo оплаты заказа → 400 (отменять в карточке заказа)', async () => {
    const connId = await seedInbox();
    const income = await lineByExt(connId, 'fake-1');
    const order = await H.prisma.order.create({
      data: {
        workspaceId: ws(),
        number: 'ORD-INBOX-3',
        status: 'OPEN',
        subtotal: new Prisma.Decimal('15000'),
        totalAmount: new Prisma.Decimal('15000'),
        items: { create: [{ name: 'T', qty: '1', unitPrice: '15000', lineTotal: '15000' }] },
      },
    });
    await H.inject({
      method: 'POST',
      url: `${inbox()}/${income.id}/attach-order`,
      token,
      payload: { orderId: order.id },
    });
    const undo = await H.inject({ method: 'POST', url: `${inbox()}/${income.id}/undo`, token });
    expect(undo.statusCode).toBe(400);
    // Оплата НЕ снята: она жива, paidAmount не откатился.
    const pay = await H.prisma.transaction.findFirstOrThrow({
      where: { orderId: order.id, kind: 'ORDER_PAYMENT' },
    });
    expect(pay.deletedAt).toBeNull();
    const o = await H.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(o.paidAmount.toString()).toBe('15000');
  });

  it('гонка двойного categorize одной строки → ровно одна проводка', async () => {
    const connId = await seedInbox();
    const line = await lineByExt(connId, 'fake-3');
    const cat = await H.prisma.category.create({
      data: { workspaceId: ws(), name: 'Аренда', kind: 'EXPENSE', bucket: 'FIXED' },
    });
    const url = `${inbox()}/${line.id}/categorize`;
    const payload = { categoryId: cat.id };
    const [a, b] = await Promise.all([
      H.inject({ method: 'POST', url, token, payload }),
      H.inject({ method: 'POST', url, token, payload }),
    ]);
    // Один запрос успел (200), другой — 409/400 (строка уже разобрана).
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes[0]).toBe(200);
    expect([400, 409]).toContain(codes[1]);
    // Ровно ОДНА проводка на строку (не две).
    const txCount = await H.prisma.transaction.count({
      where: { workspaceId: ws(), accountId: seed.accountId, categoryId: cat.id, deletedAt: null },
    });
    expect(txCount).toBe(1);
  });

  it('повторный разбор уже разобранной строки → 400', async () => {
    const connId = await seedInbox();
    const line = await lineByExt(connId, 'fake-4');
    await H.inject({ method: 'POST', url: `${inbox()}/${line.id}/dismiss`, token });
    const again = await H.inject({ method: 'POST', url: `${inbox()}/${line.id}/dismiss`, token });
    expect(again.statusCode).toBe(400);
  });
});
