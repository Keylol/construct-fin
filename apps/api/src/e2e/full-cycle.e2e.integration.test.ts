/**
 * HTTP-e2e: один полный бизнес-цикл через РЕАЛЬНЫЕ эндпоинты, гарды и пайплайн.
 *
 * Прогоняет связную историю торгового бизнеса через настоящий Nest+Fastify
 * (buildHttpApp / http-harness), не минуя JwtAuthGuard и WorkspaceGuard:
 *
 *   health → справочники (категория + клиент) → склад+закупка (WAVG)
 *   → заказ → частичная отгрузка → оплата → финализация → возврат
 *   → перевод между счетами → отчёты (P&L / cashflow / маржа / дебиторка)
 *   → сверка (снимок + отчёт) → негатив (401 без токена, 403 к чужому ws).
 *
 * На каждом шаге проверяем HTTP-статус и ключевые поля ответа.
 *
 * Авторизация: User+Workspace+Account сидятся прямо через prisma (seedBase),
 * членство — через seedMember (иначе WorkspaceGuard вернёт 403). JWT минтится
 * через jwtFor (app.get(JwtService)).
 *
 * Диапазон telegramId этого файла: 1900000n+ (не пересекается с другими сьютами).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildHttpApp, type HttpApp } from './http-harness';
import {
  resetDb,
  seedBase,
  seedMember,
  type Seed,
} from '../test/money-harness';

const num = (v: { toString(): string }) => Number(v.toString());

let H: HttpApp;
let seed: Seed;
let token: string;
let tg = 1900000n; // уникальный диапазон telegramId для этого файла

beforeAll(async () => {
  H = await buildHttpApp();
});

afterAll(async () => {
  await H.app.close();
});

beforeEach(async () => {
  await resetDb(H.prisma);
  tg += 1n;
  // User + Workspace(owner) + Account(CASH) — прямо через prisma.
  seed = await seedBase(H.prisma, tg);
  // ОБЯЗАТЕЛЬНО: членство OWNER, иначе WorkspaceGuard → 403.
  await seedMember(H.prisma, seed.workspaceId, seed.userId);
  token = await H.jwtFor(seed.userId, tg);
});

describe('Полный бизнес-цикл через HTTP (реальные эндпоинты + гарды)', () => {
  it('health → закупка → заказ → отгрузка → оплата → финализация → возврат → перевод → отчёты → сверка → негатив', async () => {
    const ws = seed.workspaceId;

    // ── 1. GET /health → 200 ──────────────────────────────────────────────
    const health = await H.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json<{ status: string }>().status).toBe('ok');

    // ── 2. Справочники: категория (выручка) + контрагент-клиент ───────────
    const catRes = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/categories`,
      token,
      payload: { name: 'Продажи', kind: 'INCOME', bucket: 'REVENUE' },
    });
    expect(catRes.statusCode).toBe(201);
    const category = catRes.json<{ id: string; kind: string; bucket: string }>();
    expect(category.id).toBeTruthy();
    expect(category.kind).toBe('INCOME');
    expect(category.bucket).toBe('REVENUE');

    const cpRes = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/counterparties`,
      token,
      payload: { name: 'ООО Клиент', role: 'CLIENT', source: 'Сайт' },
    });
    expect(cpRes.statusCode).toBe(201);
    const client = cpRes.json<{ id: string; name: string; role: string }>();
    expect(client.id).toBeTruthy();
    expect(client.role).toBe('CLIENT');

    // ── 3. Склад: позиция через HTTP + закупка (WAVG) ─────────────────────
    const itemRes = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/warehouse`,
      token,
      payload: { name: 'Деталь A', unit: 'шт' },
    });
    expect(itemRes.statusCode).toBe(201);
    const item = itemRes.json<{ id: string; name: string }>();
    expect(item.id).toBeTruthy();

    // Закупка: 10@100 + 10@200 → остаток 20, avgCost = (1000+2000)/20 = 150.
    const purchaseRes = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/purchases`,
      token,
      payload: {
        accountId: seed.accountId,
        supplierId: null,
        lines: [
          { warehouseItemId: item.id, qty: '10', unitPrice: '100' },
          { warehouseItemId: item.id, qty: '10', unitPrice: '200' },
        ],
      },
    });
    expect(purchaseRes.statusCode).toBe(201);
    const purchase = purchaseRes.json<{
      id: string;
      lines: unknown[];
      transaction: { type: string; amount: string; kind: string };
    }>();
    expect(purchase.id).toBeTruthy();
    expect(purchase.lines.length).toBe(2);
    expect(purchase.transaction.kind).toBe('PURCHASE');
    expect(purchase.transaction.type).toBe('EXPENSE');
    expect(num(purchase.transaction.amount)).toBe(3000);

    // Проверяем WAVG фактом в БД (отчёты строятся поверх него).
    const itemAfter = await H.prisma.warehouseItem.findUniqueOrThrow({
      where: { id: item.id },
    });
    expect(num(itemAfter.qty)).toBe(20);
    expect(num(itemAfter.avgCost)).toBe(150);

    // ── 4. Заказ: 10 шт по 500 (итог 5000), клиент + складская позиция ────
    const orderRes = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/orders`,
      token,
      payload: {
        clientId: client.id,
        title: 'Заказ №1',
        items: [
          {
            warehouseItemId: item.id,
            name: 'Деталь A',
            qty: '10',
            unitPrice: '500',
          },
        ],
      },
    });
    expect(orderRes.statusCode).toBe(201);
    const order = orderRes.json<{
      id: string;
      number: string;
      status: string;
      paymentStatus: string;
      totalAmount: string;
      items: { id: string; qty: string; unitPrice: string }[];
    }>();
    expect(order.id).toBeTruthy();
    expect(order.status).toBe('OPEN');
    expect(order.paymentStatus).toBe('UNPAID');
    expect(num(order.totalAmount)).toBe(5000);
    expect(order.items.length).toBe(1);
    const orderItemId = order.items[0]!.id;

    // ── 5a. Частичная отгрузка: 4 из 10 (склад списывается сразу) ─────────
    const shipRes = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/orders/${order.id}/ship`,
      token,
      payload: { itemId: orderItemId, qty: '4' },
    });
    expect(shipRes.statusCode).toBe(200);
    const shipped = shipRes.json<{
      status: string;
      items: { id: string; shippedQty: string }[];
    }>();
    expect(shipped.status).toBe('OPEN'); // отгрузка не закрывает заказ
    const shippedItem = shipped.items.find((i) => i.id === orderItemId)!;
    expect(num(shippedItem.shippedQty)).toBe(4);

    // Склад уменьшился на 4 (20 → 16).
    const itemAfterShip = await H.prisma.warehouseItem.findUniqueOrThrow({
      where: { id: item.id },
    });
    expect(num(itemAfterShip.qty)).toBe(16);

    // ── 5b. Оплата: 3000 из 5000 → PARTIAL ────────────────────────────────
    const payRes = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/orders/${order.id}/payments`,
      token,
      payload: { amount: '3000', accountId: seed.accountId },
    });
    expect(payRes.statusCode).toBe(200);
    const paid = payRes.json<{ paidAmount: string; paymentStatus: string }>();
    expect(num(paid.paidAmount)).toBe(3000);
    expect(paid.paymentStatus).toBe('PARTIAL');

    // Транзакция оплаты создана как ORDER_PAYMENT / INCOME.
    const payTx = await H.prisma.transaction.findFirstOrThrow({
      where: { workspaceId: ws, orderId: order.id, kind: 'ORDER_PAYMENT' },
    });
    expect(payTx.type).toBe('INCOME');
    expect(num(payTx.amount)).toBe(3000);

    // ── 5c. Финализация: дотгружает остаток (6), закрывает заказ DONE ─────
    const finalRes = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/orders/${order.id}/finalize`,
      token,
    });
    expect(finalRes.statusCode).toBe(200);
    const finalized = finalRes.json<{
      status: string;
      items: { id: string; shippedQty: string }[];
    }>();
    expect(finalized.status).toBe('DONE');
    const finItem = finalized.items.find((i) => i.id === orderItemId)!;
    expect(num(finItem.shippedQty)).toBe(10);

    // Весь заказ отгружен → склад 20 − 10 = 10.
    const itemAfterFinal = await H.prisma.warehouseItem.findUniqueOrThrow({
      where: { id: item.id },
    });
    expect(num(itemAfterFinal.qty)).toBe(10);

    // ── 6. Возврат клиента: 2 шт, рефанд 1000 ─────────────────────────────
    const returnRes = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/orders/${order.id}/returns`,
      token,
      payload: {
        itemId: orderItemId,
        returnQty: '2',
        refundAmount: '1000',
        accountId: seed.accountId,
      },
    });
    expect(returnRes.statusCode).toBe(200);
    const returned = returnRes.json<{
      status: string;
      items: { id: string; returnedQty: string }[];
    }>();
    const retItem = returned.items.find((i) => i.id === orderItemId)!;
    expect(num(retItem.returnedQty)).toBe(2);

    // Возврат 2 шт на склад → 10 + 2 = 12; рефанд = ORDER_REFUND / EXPENSE.
    const itemAfterReturn = await H.prisma.warehouseItem.findUniqueOrThrow({
      where: { id: item.id },
    });
    expect(num(itemAfterReturn.qty)).toBe(12);
    const refundTx = await H.prisma.transaction.findFirstOrThrow({
      where: { workspaceId: ws, orderId: order.id, kind: 'ORDER_REFUND' },
    });
    expect(refundTx.type).toBe('EXPENSE');
    expect(num(refundTx.amount)).toBe(1000);

    // ── 7. Перевод между счетами (создаём 2-й счёт) ───────────────────────
    const acc2Res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/accounts`,
      token,
      payload: { name: 'Расчётный', type: 'BANK', openingBalance: '0' },
    });
    expect(acc2Res.statusCode).toBe(201);
    const acc2 = acc2Res.json<{ id: string }>();
    expect(acc2.id).toBeTruthy();

    const transferRes = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/transfers`,
      token,
      payload: {
        fromAccountId: seed.accountId,
        toAccountId: acc2.id,
        amount: '1000',
        fee: '50',
        date: new Date().toISOString(),
        note: 'Вывод на р/с',
      },
    });
    expect(transferRes.statusCode).toBe(201);
    const transfer = transferRes.json<{
      id: string;
      fromAccountId: string;
      toAccountId: string;
      amount: string;
      fee: string;
    }>();
    expect(transfer.id).toBeTruthy();
    expect(transfer.fromAccountId).toBe(seed.accountId);
    expect(transfer.toAccountId).toBe(acc2.id);
    expect(num(transfer.amount)).toBe(1000);
    expect(num(transfer.fee)).toBe(50);

    // ── 8. Отчёты ─────────────────────────────────────────────────────────
    // P&L (текущий год): выручка по заказу должна сидеть в income.
    const pnlRes = await H.inject({
      method: 'GET',
      url: `/workspaces/${ws}/reports/pnl?preset=this-year`,
      token,
    });
    expect(pnlRes.statusCode).toBe(200);
    const pnl = pnlRes.json<{
      primary: { totals: { income: string; expense: string; net: string } };
    }>();
    // Оплата заказа (3000) — единственный INCOME → income > 0.
    expect(num(pnl.primary.totals.income)).toBeGreaterThan(0);

    // Cashflow (консолидированный, текущий год) → возвращает series.
    const cfRes = await H.inject({
      method: 'GET',
      url: `/workspaces/${ws}/reports/cashflow?preset=this-year`,
      token,
    });
    expect(cfRes.statusCode).toBe(200);
    const cf = cfRes.json<{ series: unknown[]; period: { from: string } }>();
    expect(Array.isArray(cf.series)).toBe(true);
    expect(cf.period.from).toBeTruthy();

    // Маржа по продукту (только DONE-заказы): должна содержать «Деталь A».
    const marginRes = await H.inject({
      method: 'GET',
      url: `/workspaces/${ws}/trade-reports/margin/by-product`,
      token,
    });
    expect(marginRes.statusCode).toBe(200);
    const margin = marginRes.json<{
      method: string;
      totals: { revenue: string; cogs: string; margin: string };
      rows: { name: string; revenue: string }[];
    }>();
    expect(margin.method).toBe('by-product');
    const prodRow = margin.rows.find((r) => r.name === 'Деталь A');
    expect(prodRow).toBeTruthy();
    // Выручка по продукту = 10·500 = 5000 (возврат маржу в cash-basis MVP не сужает).
    expect(num(prodRow!.revenue)).toBe(5000);
    // COGS = 10·150 (WAVG) = 1500 → маржа 3500.
    expect(num(margin.totals.cogs)).toBe(1500);
    expect(num(margin.totals.margin)).toBe(3500);

    // Дебиторка: заказ оплачен на 3000 из 5000, рефанд 1000 вернул деньги
    // клиенту → остаток долга по заказу должен быть положительным.
    const recvRes = await H.inject({
      method: 'GET',
      url: `/workspaces/${ws}/trade-reports/receivables`,
      token,
    });
    expect(recvRes.statusCode).toBe(200);
    const recv = recvRes.json<{
      totalDue: string;
      clients: { clientName: string; due: string }[];
    }>();
    expect(num(recv.totalDue)).toBeGreaterThan(0);
    expect(recv.clients.some((c) => c.clientName === 'ООО Клиент')).toBe(true);

    // ── 9. Сверка: снимок факт-остатка, затем отчёт сверки ────────────────
    const checkRes = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/reconciliation/checks`,
      token,
      payload: {
        accountId: seed.accountId,
        date: new Date().toISOString(),
        actualBalance: '12345.67',
        note: 'Сверка по выписке',
      },
    });
    expect(checkRes.statusCode).toBe(201);
    const check = checkRes.json<{ id: string; actualBalance: string }>();
    expect(check.id).toBeTruthy();
    expect(num(check.actualBalance)).toBe(12345.67);

    const reconRes = await H.inject({
      method: 'GET',
      url: `/workspaces/${ws}/reconciliation?accountId=${seed.accountId}`,
      token,
    });
    expect(reconRes.statusCode).toBe(200);
    const recon = reconRes.json<{
      accountId: string;
      computedBalance: string;
      lastCheck: { actualBalance: string; discrepancy: string } | null;
    }>();
    expect(recon.accountId).toBe(seed.accountId);
    expect(recon.computedBalance).toBeTruthy();
    expect(recon.lastCheck).not.toBeNull();
    expect(num(recon.lastCheck!.actualBalance)).toBe(12345.67);

    // ── 10. Негатив ───────────────────────────────────────────────────────
    // 10a. Без токена → 401.
    const noToken = await H.inject({
      method: 'GET',
      url: `/workspaces/${ws}/accounts`,
    });
    expect(noToken.statusCode).toBe(401);

    // 10b. Чужой workspace (без членства тест-юзера) → 403.
    const otherUser = await H.prisma.user.create({
      data: { telegramId: tg + 1000000n, username: 'other', firstName: 'Other' },
    });
    const otherWs = await H.prisma.workspace.create({
      data: { name: 'Чужой WS', ownerId: otherUser.id },
    });
    // токен НАШЕГО юзера, но членства в otherWs у него нет → WorkspaceGuard 403.
    const forbidden = await H.inject({
      method: 'GET',
      url: `/workspaces/${otherWs.id}/accounts`,
      token,
    });
    expect(forbidden.statusCode).toBe(403);
  });
});
