/**
 * Функциональные тесты мутаций закупок (Фаза 2.2 — «кнопка → HTTP → БД»).
 *
 * Через РЕАЛЬНЫЙ Nest+Fastify (buildHttpApp): JwtAuthGuard + WorkspaceGuard +
 * ZodPipe + AllExceptionsFilter — полный прод-пайплайн. Закупка АТОМАРНА:
 * Transaction(EXPENSE/PURCHASE) + Purchase + PurchaseLine[] + приход на склад с
 * пересчётом WAVG + StockMovement(PURCHASE). На каждую мутацию: запрос →
 * проверка HTTP-кода → проверка точных последствий в БД через Prisma.
 *
 * Эндпоинт: POST /purchases.
 * Диапазон telegramId: 2420000n+ (не пересекается с другими сьютами).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildHttpApp, type HttpApp } from '../e2e/http-harness';
import {
  resetDb,
  seedBase,
  seedMember,
  seedStockItem,
  seedWarehouseItem,
  type Seed,
} from '../test/money-harness';

let H: HttpApp;
let seed: Seed;
let token: string;
let tg = 2420000n;

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

describe('Функциональные мутации: закупки (purchases)', () => {
  it('POST /purchases → 201: приход на склад, WAVG, Transaction(EXPENSE/PURCHASE), StockMovement(PURCHASE)', async () => {
    const ws = seed.workspaceId;
    const itemId = await seedWarehouseItem(H.prisma, ws, 'Цемент'); // qty=0, avgCost=0

    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/purchases`,
      token,
      payload: {
        accountId: seed.accountId,
        note: 'первая закупка',
        lines: [{ warehouseItemId: itemId, qty: '10', unitPrice: '100' }],
      },
    });
    expect(res.statusCode).toBe(201);
    const created = res.json<{ id: string; transactionId: string }>();
    expect(created.id).toBeTruthy();

    // Склад: qty 0→10, avgCost 0→100 (первый приход).
    const item = await H.prisma.warehouseItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(item.qty.toString()).toBe('10');
    expect(item.avgCost.toString()).toBe('100');

    // Деньги: расход (EXPENSE / PURCHASE) на сумму Σ lineTotal = 10*100 = 1000.
    const txs = await H.prisma.transaction.findMany({ where: { workspaceId: ws } });
    expect(txs).toHaveLength(1);
    expect(txs[0]!.type).toBe('EXPENSE');
    expect(txs[0]!.kind).toBe('PURCHASE');
    expect(txs[0]!.accountId).toBe(seed.accountId);
    expect(txs[0]!.amount.toFixed(2)).toBe('1000.00');

    // Документ закупки: 1:1 с транзакцией + одна строка.
    const purchase = await H.prisma.purchase.findUniqueOrThrow({
      where: { id: created.id },
      include: { lines: true },
    });
    expect(purchase.transactionId).toBe(txs[0]!.id);
    expect(purchase.lines).toHaveLength(1);
    expect(purchase.lines[0]!.warehouseItemId).toBe(itemId);
    expect(purchase.lines[0]!.qty.toString()).toBe('10');
    expect(purchase.lines[0]!.unitPrice.toString()).toBe('100');
    expect(purchase.lines[0]!.lineTotal.toFixed(2)).toBe('1000.00');

    // Движение склада: PURCHASE, +qty, unitCost = цена прихода, ссылка на Purchase.
    const moves = await H.prisma.stockMovement.findMany({ where: { warehouseItemId: itemId } });
    expect(moves).toHaveLength(1);
    expect(moves[0]!.type).toBe('PURCHASE');
    expect(moves[0]!.qtyDelta.toString()).toBe('10');
    expect(moves[0]!.qtyAfter.toString()).toBe('10');
    expect(moves[0]!.unitCost!.toString()).toBe('100');
    expect(moves[0]!.refType).toBe('Purchase');
    expect(moves[0]!.refId).toBe(created.id);
  });

  it('POST /purchases → пересчёт avgCost-кэша на непустом остатке (FIFO)', async () => {
    const ws = seed.workspaceId;
    // Остаток 10 @ 50, материализованный OPENING-партией (иначе avgCost-кэш увидел бы
    // только партию закупки). FIFO-кэш для чистых закупок без продаж == WAVG.
    const { id: itemId } = await seedStockItem(H.prisma, {
      workspaceId: ws,
      createdById: seed.userId,
      name: 'Песок',
      qty: '10',
      unitCost: '50',
    });

    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/purchases`,
      token,
      payload: {
        accountId: seed.accountId,
        lines: [{ warehouseItemId: itemId, qty: '10', unitPrice: '100' }],
      },
    });
    expect(res.statusCode).toBe(201);

    // Две открытые партии: 10@50 + 10@100 → avgCost-кэш = Σ(qtyRem·unitCost)/Σqty =
    // (10*50 + 10*100) / 20 = 1500/20 = 75; qty 20.
    const row = await H.prisma.warehouseItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(row.qty.toString()).toBe('20');
    expect(row.avgCost.toString()).toBe('75');
  });

  it('POST /purchases → многострочная закупка: amount = сумма строк, движение на каждую', async () => {
    const ws = seed.workspaceId;
    const a = await seedWarehouseItem(H.prisma, ws, 'Кирпич');
    const b = await seedWarehouseItem(H.prisma, ws, 'Раствор');

    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/purchases`,
      token,
      payload: {
        accountId: seed.accountId,
        lines: [
          { warehouseItemId: a, qty: '5', unitPrice: '20' }, // 100
          { warehouseItemId: b, qty: '2', unitPrice: '150' }, // 300
        ],
      },
    });
    expect(res.statusCode).toBe(201);

    const txs = await H.prisma.transaction.findMany({ where: { workspaceId: ws } });
    expect(txs).toHaveLength(1);
    expect(txs[0]!.amount.toFixed(2)).toBe('400.00'); // 100 + 300

    const moves = await H.prisma.stockMovement.findMany({
      where: { workspaceId: ws, type: 'PURCHASE' },
    });
    expect(moves).toHaveLength(2);
    const itemA = await H.prisma.warehouseItem.findUniqueOrThrow({ where: { id: a } });
    const itemB = await H.prisma.warehouseItem.findUniqueOrThrow({ where: { id: b } });
    expect(itemA.qty.toString()).toBe('5');
    expect(itemA.avgCost.toString()).toBe('20');
    expect(itemB.qty.toString()).toBe('2');
    expect(itemB.avgCost.toString()).toBe('150');
  });

  it('POST /purchases → 400 на пустом lines[] (ни закупки, ни транзакции, ни движения)', async () => {
    const ws = seed.workspaceId;
    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/purchases`,
      token,
      payload: { accountId: seed.accountId, lines: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(await H.prisma.purchase.count({ where: { workspaceId: ws } })).toBe(0);
    expect(await H.prisma.transaction.count({ where: { workspaceId: ws } })).toBe(0);
    expect(await H.prisma.stockMovement.count({ where: { workspaceId: ws } })).toBe(0);
  });

  it('POST /purchases → 404 на чужом accountId (cross-tenant): закупка не проводится', async () => {
    const ws = seed.workspaceId;
    const itemId = await seedWarehouseItem(H.prisma, ws, 'Гипс');

    // Счёт в ЧУЖОМ workspace.
    const otherWs = await H.prisma.workspace.create({
      data: {
        name: 'Чужой',
        owner: { create: { telegramId: tg + 700000n, username: 'oth', firstName: 'O' } },
      },
    });
    const foreignAcc = await H.prisma.account.create({
      data: { workspaceId: otherWs.id, name: 'Чужой счёт', type: 'CASH' },
    });

    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/purchases`,
      token,
      payload: {
        accountId: foreignAcc.id,
        lines: [{ warehouseItemId: itemId, qty: '1', unitPrice: '10' }],
      },
    });
    expect(res.statusCode).toBe(404);
    // Ничего не записано, склад не тронут.
    expect(await H.prisma.purchase.count({ where: { workspaceId: ws } })).toBe(0);
    expect(await H.prisma.transaction.count({ where: { workspaceId: ws } })).toBe(0);
    const item = await H.prisma.warehouseItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(item.qty.toString()).toBe('0');
  });

  it('негатив: 401 без токена и 403 к чужому workspace', async () => {
    const ws = seed.workspaceId;
    const itemId = await seedWarehouseItem(H.prisma, ws, 'Краска');

    const noAuth = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/purchases`,
      payload: {
        accountId: seed.accountId,
        lines: [{ warehouseItemId: itemId, qty: '1', unitPrice: '1' }],
      },
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
      url: `/workspaces/${otherWs.id}/purchases`,
      token,
      payload: {
        accountId: seed.accountId,
        lines: [{ warehouseItemId: itemId, qty: '1', unitPrice: '1' }],
      },
    });
    expect(forbidden.statusCode).toBe(403);
  });
});
