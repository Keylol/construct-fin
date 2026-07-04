/**
 * Функциональные тесты мутаций склада (Фаза 2.2 — «кнопка → HTTP → БД»).
 *
 * Через РЕАЛЬНЫЙ Nest+Fastify (buildHttpApp): JwtAuthGuard + WorkspaceGuard +
 * ZodPipe + AllExceptionsFilter — полный прод-пайплайн. На каждую мутацию:
 * запрос → проверка HTTP-кода → проверка точных последствий в БД через Prisma
 * (qty / avgCost / StockMovement / Transaction).
 *
 * Эндпоинты: POST /warehouse · PATCH /warehouse/:id · DELETE /warehouse/:id ·
 * POST /warehouse/:id/adjust · POST /warehouse/:id/set-cost ·
 * POST /warehouse/:id/supplier-return · POST /warehouse/import/preview ·
 * POST /warehouse/import/commit.
 * Диапазон telegramId: 2400000n+ (не пересекается с другими сьютами).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import ExcelJS from 'exceljs';
import { buildHttpApp, type HttpApp } from '../e2e/http-harness';
import { resetDb, seedBase, seedMember, seedStockItem, type Seed } from '../test/money-harness';

let H: HttpApp;
let seed: Seed;
let token: string;
let tg = 2400000n;

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

describe('Функциональные мутации: склад (warehouse)', () => {
  it('POST /warehouse → 201 и создаёт WarehouseItem с начальным остатком и себестоимостью', async () => {
    const ws = seed.workspaceId;
    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/warehouse`,
      token,
      payload: {
        name: 'Болт М6',
        sku: 'B-6',
        unit: 'кг',
        openingQty: '10',
        openingCost: '50',
        note: 'старт',
      },
    });
    expect(res.statusCode).toBe(201);
    const created = res.json<{ id: string }>();
    expect(created.id).toBeTruthy();

    const row = await H.prisma.warehouseItem.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.workspaceId).toBe(ws);
    expect(row.name).toBe('Болт М6');
    expect(row.sku).toBe('B-6');
    expect(row.unit).toBe('кг');
    expect(row.qty.toString()).toBe('10');
    expect(row.avgCost.toString()).toBe('50');
    expect(row.note).toBe('старт');
    expect(row.deletedAt).toBeNull();
    // FIFO: create() с openingQty атомарно создаёт OPENING-партию + OPENING-движение
    // (qty == Σ движений — намеренный фикс латентного разрыва остатка и журнала).
    const moves = await H.prisma.stockMovement.findMany({ where: { warehouseItemId: created.id } });
    expect(moves).toHaveLength(1);
    expect(moves[0]!.type).toBe('OPENING');
    expect(moves[0]!.qtyDelta.toString()).toBe('10');
    expect(moves[0]!.qtyAfter.toString()).toBe('10');
    expect(moves[0]!.unitCost!.toString()).toBe('50');
  });

  it('POST /warehouse → дефолты unit=шт, qty=0, avgCost=0', async () => {
    const ws = seed.workspaceId;
    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/warehouse`,
      token,
      payload: { name: 'Гайка' },
    });
    expect(res.statusCode).toBe(201);
    const row = await H.prisma.warehouseItem.findUniqueOrThrow({
      where: { id: res.json<{ id: string }>().id },
    });
    expect(row.unit).toBe('шт');
    expect(row.qty.toString()).toBe('0');
    expect(row.avgCost.toString()).toBe('0');
  });

  it('POST /warehouse → 400 на пустом name (ZodPipe), запись не создаётся', async () => {
    const ws = seed.workspaceId;
    const before = await H.prisma.warehouseItem.count({ where: { workspaceId: ws } });
    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/warehouse`,
      token,
      payload: { name: '' },
    });
    expect(res.statusCode).toBe(400);
    const after = await H.prisma.warehouseItem.count({ where: { workspaceId: ws } });
    expect(after).toBe(before);
  });

  it('PATCH /warehouse/:id → 200 и обновляет поля в БД', async () => {
    const ws = seed.workspaceId;
    // qty:0 — архивация с остатком теперь запрещена (F2), а тест проверяет
    // обновление полей включая isArchived.
    const item = await H.prisma.warehouseItem.create({
      data: { workspaceId: ws, name: 'Старое', unit: 'шт', qty: '0', avgCost: '0' },
    });
    const res = await H.inject({
      method: 'PATCH',
      url: `/workspaces/${ws}/warehouse/${item.id}`,
      token,
      payload: { name: 'Новое', unit: 'кг', isArchived: true },
    });
    expect(res.statusCode).toBe(200);
    const row = await H.prisma.warehouseItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(row.name).toBe('Новое');
    expect(row.unit).toBe('кг');
    expect(row.isArchived).toBe(true);
    // qty/avgCost не передавались и через update не двигаются (фикстура 0/0).
    expect(row.qty.toString()).toBe('0');
    expect(row.avgCost.toString()).toBe('0');
  });

  it('DELETE /warehouse/:id → 200 и помечает запись soft-deleted (deletedAt)', async () => {
    const ws = seed.workspaceId;
    const item = await H.prisma.warehouseItem.create({
      data: { workspaceId: ws, name: 'НаУдаление' },
    });
    const res = await H.inject({
      method: 'DELETE',
      url: `/workspaces/${ws}/warehouse/${item.id}`,
      token,
    });
    expect(res.statusCode).toBe(200); // @HttpCode(200), тело { ok: true }
    expect(res.json<{ ok: boolean }>().ok).toBe(true);
    const row = await H.prisma.warehouseItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(row.deletedAt).not.toBeNull();
  });

  it('POST /warehouse/:id/adjust → 200, меняет qty и пишет StockMovement(ADJUSTMENT)', async () => {
    const ws = seed.workspaceId;
    // FIFO: остаток 10 материализуем партией @30; adjust вниз спишет 3 из неё.
    const { id: itemId } = await seedStockItem(H.prisma, {
      workspaceId: ws,
      createdById: seed.userId,
      name: 'Доска',
      qty: '10',
      unitCost: '30',
    });
    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/warehouse/${itemId}/adjust`,
      token,
      payload: { newQty: '7', reason: 'инвентаризация' },
    });
    expect(res.statusCode).toBe(200);

    const row = await H.prisma.warehouseItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(row.qty.toString()).toBe('7');
    // FIFO: списали 3 из партии @30, осталось 7@30 → avgCost-кэш = 30 (не размывается).
    expect(row.avgCost.toString()).toBe('30');

    // Берём ADJUSTMENT-движение (помимо него есть OPENING от сидирования партии).
    const moves = await H.prisma.stockMovement.findMany({
      where: { warehouseItemId: itemId, type: 'ADJUSTMENT' },
    });
    expect(moves).toHaveLength(1);
    expect(moves[0]!.qtyDelta.toString()).toBe('-3'); // 7 − 10
    expect(moves[0]!.qtyAfter.toString()).toBe('7');
    expect(moves[0]!.reason).toBe('инвентаризация');
  });

  it('POST /warehouse/:id/adjust → newQty == текущему: движение не пишется', async () => {
    const ws = seed.workspaceId;
    const item = await H.prisma.warehouseItem.create({
      data: { workspaceId: ws, name: 'Лист', qty: '4', avgCost: '5' },
    });
    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/warehouse/${item.id}/adjust`,
      token,
      payload: { newQty: '4' },
    });
    expect(res.statusCode).toBe(200);
    const moves = await H.prisma.stockMovement.count({ where: { warehouseItemId: item.id } });
    expect(moves).toBe(0);
  });

  it('POST /warehouse/:id/set-cost → 200, задаёт avgCost (qty не трогает), движение без денег', async () => {
    const ws = seed.workspaceId;
    // FIFO: неоценённый остаток 10 — партия @0; setCost проставит ей цену.
    const { id: itemId } = await seedStockItem(H.prisma, {
      workspaceId: ws,
      createdById: seed.userId,
      name: 'Уголок',
      qty: '10',
      unitCost: '0',
    });
    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/warehouse/${itemId}/set-cost`,
      token,
      payload: { unitCost: '25', reason: 'оценка остатка' },
    });
    expect(res.statusCode).toBe(200);

    const row = await H.prisma.warehouseItem.findUniqueOrThrow({ where: { id: itemId } });
    // setCost проставил unitCost=25 нулевой партии → avgCost-кэш = (10·25)/10 = 25.
    expect(row.avgCost.toString()).toBe('25');
    expect(row.qty.toString()).toBe('10'); // qty НЕ меняется

    // Берём ADJUSTMENT-движение (помимо него есть OPENING от сидирования партии).
    const moves = await H.prisma.stockMovement.findMany({
      where: { warehouseItemId: itemId, type: 'ADJUSTMENT' },
    });
    expect(moves).toHaveLength(1);
    expect(moves[0]!.qtyDelta.toString()).toBe('0');
    expect(moves[0]!.qtyAfter.toString()).toBe('10');
    expect(moves[0]!.unitCost!.toString()).toBe('25');

    // cash-basis: установка себестоимости начального остатка НЕ создаёт Transaction.
    const txs = await H.prisma.transaction.count({ where: { workspaceId: ws } });
    expect(txs).toBe(0);
  });

  it('POST /warehouse/:id/set-cost → 400 на уже оценённой позиции (avgCost>0)', async () => {
    const ws = seed.workspaceId;
    const item = await H.prisma.warehouseItem.create({
      data: { workspaceId: ws, name: 'Труба', qty: '5', avgCost: '12' },
    });
    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/warehouse/${item.id}/set-cost`,
      token,
      payload: { unitCost: '99' },
    });
    expect(res.statusCode).toBe(400);
    const row = await H.prisma.warehouseItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(row.avgCost.toString()).toBe('12'); // не перезаписано
  });

  it('POST /warehouse/:id/supplier-return → 200: уменьшает qty, пишет RETURN_SUPPLIER и INCOME(SUPPLIER_REFUND)', async () => {
    const ws = seed.workspaceId;
    // FIFO: остаток 10 одной партией @50; возврат спишет 4 из неё по её цене.
    const { id: itemId } = await seedStockItem(H.prisma, {
      workspaceId: ws,
      createdById: seed.userId,
      name: 'Кабель',
      qty: '10',
      unitCost: '50',
    });
    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/warehouse/${itemId}/supplier-return`,
      token,
      payload: { returnQty: '4', refundAmount: '200', accountId: seed.accountId, reason: 'брак' },
    });
    expect(res.statusCode).toBe(200);

    // Склад: qty 10−4=6. M1 устранён — списываем конкретную партию по её цене,
    // avgCost НЕ размывается рефандом: остаётся 6@50 → avgCost-кэш = 50.
    const row = await H.prisma.warehouseItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(row.qty.toString()).toBe('6');
    expect(row.avgCost.toString()).toBe('50');

    // Движение склада: RETURN_SUPPLIER, отрицательный qtyDelta, unitCost = себестоимость
    // списанной партии. Помимо него есть OPENING от сидирования — фильтруем по типу.
    const moves = await H.prisma.stockMovement.findMany({
      where: { warehouseItemId: itemId, type: 'RETURN_SUPPLIER' },
    });
    expect(moves).toHaveLength(1);
    expect(moves[0]!.qtyDelta.toString()).toBe('-4');
    expect(moves[0]!.qtyAfter.toString()).toBe('6');
    expect(moves[0]!.unitCost!.toString()).toBe('50'); // 4·50 / 4 (цена партии)

    // Деньги: приход (INCOME / SUPPLIER_REFUND) на счёт возврата.
    const txs = await H.prisma.transaction.findMany({ where: { workspaceId: ws } });
    expect(txs).toHaveLength(1);
    expect(txs[0]!.type).toBe('INCOME');
    expect(txs[0]!.kind).toBe('SUPPLIER_REFUND');
    expect(txs[0]!.accountId).toBe(seed.accountId);
    expect(txs[0]!.amount.toFixed(2)).toBe('200.00');
    // refId движения ссылается на созданную транзакцию.
    expect(moves[0]!.refId).toBe(txs[0]!.id);
  });

  it('POST /warehouse/:id/supplier-return → 400 при возврате больше остатка (нет денег/движения)', async () => {
    const ws = seed.workspaceId;
    const item = await H.prisma.warehouseItem.create({
      data: { workspaceId: ws, name: 'Провод', qty: '3', avgCost: '10' },
    });
    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/warehouse/${item.id}/supplier-return`,
      token,
      payload: { returnQty: '5', refundAmount: '50', accountId: seed.accountId },
    });
    expect(res.statusCode).toBe(400);
    const row = await H.prisma.warehouseItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(row.qty.toString()).toBe('3'); // не тронуто
    const txs = await H.prisma.transaction.count({ where: { workspaceId: ws } });
    expect(txs).toBe(0);
    const moves = await H.prisma.stockMovement.count({ where: { warehouseItemId: item.id } });
    expect(moves).toBe(0);
  });

  it('POST /warehouse/import/commit → 201: создаёт позиции + OPENING-движения, без транзакций', async () => {
    const ws = seed.workspaceId;
    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/warehouse/import/commit`,
      token,
      payload: {
        rows: [
          { name: 'Винт', qty: '50', avgCost: '10', unit: 'шт', reorderPoint: '5' },
          { name: 'Шайба', qty: '30', avgCost: '5' },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ created: number; skipped: number }>()).toEqual({ created: 2, skipped: 0 });

    const items = await H.prisma.warehouseItem.findMany({ where: { workspaceId: ws } });
    expect(items).toHaveLength(2);
    const vint = items.find((i) => i.name === 'Винт')!;
    expect(vint.qty.toString()).toBe('50');
    expect(vint.avgCost.toString()).toBe('10');
    expect(vint.unit).toBe('шт');
    expect(vint.reorderPoint!.toString()).toBe('5');

    const openings = await H.prisma.stockMovement.findMany({
      where: { workspaceId: ws, type: 'OPENING' },
    });
    expect(openings).toHaveLength(2);

    // cash-basis: начальные остатки НЕ создают Transaction.
    const txs = await H.prisma.transaction.count({ where: { workspaceId: ws } });
    expect(txs).toBe(0);
  });

  it('POST /warehouse/import/commit → дедуп по name: повтор не двоит позицию', async () => {
    const ws = seed.workspaceId;
    await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/warehouse/import/commit`,
      token,
      payload: { rows: [{ name: 'Болт', qty: '50', avgCost: '10' }] },
    });
    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/warehouse/import/commit`,
      token,
      payload: { rows: [{ name: 'Болт', qty: '99', avgCost: '99' }] },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ created: number; skipped: number }>()).toEqual({ created: 0, skipped: 1 });
    const items = await H.prisma.warehouseItem.findMany({ where: { workspaceId: ws, name: 'Болт' } });
    expect(items).toHaveLength(1);
    expect(items[0]!.qty.toString()).toBe('50'); // прежнее значение не перезаписано
  });

  it('POST /warehouse/import/commit → 400 на пустом rows[] (ничего не создаётся)', async () => {
    const ws = seed.workspaceId;
    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/warehouse/import/commit`,
      token,
      payload: { rows: [] },
    });
    expect(res.statusCode).toBe(400);
    const items = await H.prisma.warehouseItem.count({ where: { workspaceId: ws } });
    expect(items).toBe(0);
  });

  it('POST /warehouse/import/preview → 201: классифицирует строки, НИЧЕГО не пишет в БД', async () => {
    const ws = seed.workspaceId;

    // Готовим xlsx-файл в памяти (заголовки + строки) под маппинг колонок.
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Склад');
    sheet.addRow(['Наименование', 'Кол-во', 'Себестоимость']);
    sheet.addRow(['Анкер', '12', '7']);
    sheet.addRow(['Дюбель', '40', '2']);
    const xlsxBuffer = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);

    const boundary = 'XbCyWarehousePreviewBoundary';
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="stock.xlsx"\r\n` +
          `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`,
      ),
      xlsxBuffer,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const mapping = encodeURIComponent(
      JSON.stringify({ name: 'Наименование', qty: 'Кол-во', avgCost: 'Себестоимость' }),
    );

    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/warehouse/import/preview?mapping=${mapping}`,
      token,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    const preview = res.json<{
      created: Array<{ name: string }>;
      skipped: unknown[];
      stats: { total: number; created: number; skipped: number };
    }>();
    expect(preview.stats.total).toBe(2);
    expect(preview.stats.created).toBe(2);
    expect(preview.created.map((r) => r.name).sort()).toEqual(['Анкер', 'Дюбель']);

    // preview ничего не пишет в БД.
    const items = await H.prisma.warehouseItem.count({ where: { workspaceId: ws } });
    expect(items).toBe(0);
  });

  it('POST /warehouse/import/preview → 400 без multipart (обычный JSON)', async () => {
    const ws = seed.workspaceId;
    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/warehouse/import/preview?mapping=${encodeURIComponent('{"name":"N"}')}`,
      token,
      payload: { not: 'multipart' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('негатив: 401 без токена и 403 к чужому workspace', async () => {
    const ws = seed.workspaceId;
    const noAuth = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/warehouse`,
      payload: { name: 'Y' },
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
      url: `/workspaces/${otherWs.id}/warehouse`,
      token,
      payload: { name: 'Z' },
    });
    expect(forbidden.statusCode).toBe(403);
  });
});
