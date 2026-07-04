/**
 * Функциональные тесты вложений (Фаза 2.2 — «кнопка → HTTP → БД»).
 *
 * Через РЕАЛЬНЫЙ Nest+Fastify (buildHttpApp): JwtAuthGuard + WorkspaceGuard +
 * ZodPipe + AllExceptionsFilter. На каждую мутацию: запрос → HTTP-код →
 * проверка точных последствий в БД через Prisma.
 *
 * Загрузка идёт ТОЛЬКО multipart/form-data (файл). Тип проверяется по
 * whitelist + «магическим байтам» (assertAllowedAttachment). Удаление вложения
 * — ФИЗИЧЕСКОЕ (Attachment без deletedAt; см. attachment.service.ts remove).
 *
 * Эндпоинты: POST /transactions/:txId/attachments · POST /orders/:orderId/attachments
 *            · DELETE /attachments/:id.
 * Диапазон telegramId: 2630000n+ (не пересекается с другими сьютами).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildHttpApp, type HttpApp } from '../e2e/http-harness';
import { resetDb, seedBase, seedMember, type Seed } from '../test/money-harness';

let H: HttpApp;
let seed: Seed;
let token: string;
let tg = 2630000n;

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

/** Валидный по сигнатуре PNG-буфер (8 байт заголовка + хвост). */
function pngBuffer(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('payload-bytes'),
  ]);
}

/** Собирает multipart/form-data тело с одним файлом. */
function multipart(boundary: string, content: Buffer, filename: string, contentType: string) {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`,
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

async function seedTransaction(): Promise<string> {
  const tx = await H.prisma.transaction.create({
    data: {
      workspaceId: seed.workspaceId,
      accountId: seed.accountId,
      date: new Date('2026-05-01'),
      amount: '100.00',
      type: 'INCOME',
      createdById: seed.userId,
    },
  });
  return tx.id;
}

async function seedOrder(): Promise<string> {
  const order = await H.prisma.order.create({
    data: { workspaceId: seed.workspaceId, number: `ORD-${tg}` },
  });
  return order.id;
}

describe('Функциональные мутации: вложения (attachments)', () => {
  it('POST /transactions/:txId/attachments → 201 (multipart PNG) и создаёт Attachment в БД', async () => {
    const ws = seed.workspaceId;
    const txId = await seedTransaction();
    const png = pngBuffer();
    const boundary = 'XbCyTxAttachBoundary';

    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/transactions/${txId}/attachments`,
      token,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipart(boundary, png, 'receipt.png', 'image/png'),
    });
    expect(res.statusCode).toBe(201);
    const created = res.json<{ id: string; filename: string; mimeType: string; size: number }>();
    expect(created.id).toBeTruthy();

    const row = await H.prisma.attachment.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.workspaceId).toBe(ws);
    expect(row.transactionId).toBe(txId);
    expect(row.orderId).toBeNull();
    expect(row.filename).toBe('receipt.png');
    expect(row.mimeType).toBe('image/png');
    expect(row.size).toBe(png.byteLength);
    expect(row.hash).toBeTruthy();
  });

  it('POST /orders/:orderId/attachments → 201 (multipart PNG) и создаёт Attachment в БД', async () => {
    const ws = seed.workspaceId;
    const orderId = await seedOrder();
    const png = pngBuffer();
    const boundary = 'XbCyOrderAttachBoundary';

    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/orders/${orderId}/attachments`,
      token,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipart(boundary, png, 'contract.png', 'image/png'),
    });
    expect(res.statusCode).toBe(201);
    const created = res.json<{ id: string }>();

    const row = await H.prisma.attachment.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.workspaceId).toBe(ws);
    expect(row.orderId).toBe(orderId);
    expect(row.transactionId).toBeNull();
    expect(row.filename).toBe('contract.png');
  });

  it('POST /transactions/:txId/attachments → 400 на недопустимом типе (text/plain), запись не создаётся', async () => {
    const ws = seed.workspaceId;
    const txId = await seedTransaction();
    const boundary = 'XbCyBadTypeBoundary';

    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/transactions/${txId}/attachments`,
      token,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipart(boundary, Buffer.from('hello'), 'note.txt', 'text/plain'),
    });
    expect(res.statusCode).toBe(400);
    expect(await H.prisma.attachment.count({ where: { workspaceId: ws } })).toBe(0);
  });

  it('POST /transactions/:txId/attachments → 400 без multipart (обычный JSON)', async () => {
    const ws = seed.workspaceId;
    const txId = await seedTransaction();
    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/transactions/${txId}/attachments`,
      token,
      payload: { not: 'multipart' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('DELETE /attachments/:id → 204 и ФИЗИЧЕСКИ удаляет запись', async () => {
    const ws = seed.workspaceId;
    const txId = await seedTransaction();
    // Заводим вложение напрямую в БД (storagePath указывает на несуществующий
    // файл — remove() безопасно игнорирует отсутствие файла на диске).
    const att = await H.prisma.attachment.create({
      data: {
        workspaceId: ws,
        transactionId: txId,
        filename: 'old.png',
        mimeType: 'image/png',
        size: 10,
        storagePath: '/nonexistent/path/old.png',
        hash: `hash-${tg}`,
      },
    });
    const res = await H.inject({
      method: 'DELETE',
      url: `/workspaces/${ws}/attachments/${att.id}`,
      token,
    });
    expect(res.statusCode).toBe(204);
    // Физическое удаление: строки больше нет (модель без deletedAt).
    const row = await H.prisma.attachment.findUnique({ where: { id: att.id } });
    expect(row).toBeNull();
  });

  // ─────────── DE6: guard download + чистка при удалении заказа ───────────

  /** Загружает PNG к заказу через multipart, возвращает id вложения. */
  async function uploadToOrder(orderId: string): Promise<string> {
    const boundary = `DE6Boundary${tg}`;
    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${seed.workspaceId}/orders/${orderId}/attachments`,
      token,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipart(boundary, pngBuffer(), 'check.png', 'image/png'),
    });
    expect(res.statusCode).toBe(201);
    return res.json<{ id: string }>().id;
  }

  it('DE6: download живого вложения заказа → 200', async () => {
    const ws = seed.workspaceId;
    const orderId = await seedOrder();
    const attId = await uploadToOrder(orderId);
    const res = await H.inject({
      method: 'GET',
      url: `/workspaces/${ws}/attachments/${attId}/download`,
      token,
    });
    expect(res.statusCode).toBe(200);
  });

  it('DE6: удаление заказа снимает его вложения (строки) и закрывает download → 404', async () => {
    const ws = seed.workspaceId;
    const orderId = await seedOrder();
    const attId = await uploadToOrder(orderId);

    const del = await H.inject({ method: 'DELETE', url: `/workspaces/${ws}/orders/${orderId}`, token });
    expect(del.statusCode).toBe(200);

    // Строки вложений заказа сняты.
    expect(await H.prisma.attachment.count({ where: { workspaceId: ws, orderId } })).toBe(0);
    // Download больше не отдаёт файл.
    const res = await H.inject({
      method: 'GET',
      url: `/workspaces/${ws}/attachments/${attId}/download`,
      token,
    });
    expect(res.statusCode).toBe(404);
  });

  it('DE6: download вложения soft-удалённой операции → 404 (строка остаётся, ловит guard)', async () => {
    const ws = seed.workspaceId;
    const txId = await seedTransaction();
    // Вложение напрямую (путь фиктивный — guard 404-ит до чтения файла с диска).
    const att = await H.prisma.attachment.create({
      data: {
        workspaceId: ws,
        transactionId: txId,
        filename: 'receipt.png',
        mimeType: 'image/png',
        size: 10,
        storagePath: '/nonexistent/de6.png',
        hash: `de6-${tg}`,
      },
    });
    // Операция soft-удалена.
    await H.prisma.transaction.update({ where: { id: txId }, data: { deletedAt: new Date() } });

    const res = await H.inject({
      method: 'GET',
      url: `/workspaces/${ws}/attachments/${att.id}/download`,
      token,
    });
    expect(res.statusCode).toBe(404);
    // Guard, а не физическое удаление: строка на месте.
    expect(await H.prisma.attachment.findUnique({ where: { id: att.id } })).not.toBeNull();
  });

  it('DE6: вложение без родителя не отдаётся (защита в глубину) → 404', async () => {
    const ws = seed.workspaceId;
    const att = await H.prisma.attachment.create({
      data: {
        workspaceId: ws,
        // ни orderId, ни transactionId — состояние, недостижимое через API.
        filename: 'orphan.png',
        mimeType: 'image/png',
        size: 10,
        storagePath: '/nonexistent/orphan.png',
        hash: `orphan-${tg}`,
      },
    });
    const res = await H.inject({
      method: 'GET',
      url: `/workspaces/${ws}/attachments/${att.id}/download`,
      token,
    });
    expect(res.statusCode).toBe(404);
  });

  it('DE6: удаление заказа чистит и вложения его платёжных операций (transactionId)', async () => {
    const ws = seed.workspaceId;
    // Заказ с позицией + оплата → создаётся ORDER_PAYMENT-операция с orderId.
    const order = await H.prisma.order.create({
      data: {
        workspaceId: ws,
        number: `ORD-PAY-${tg}`,
        items: { create: { name: 'Товар', qty: '1', unitPrice: '1000', lineTotal: '1000' } },
      },
    });
    await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/orders/${order.id}/payments`,
      token,
      payload: { amount: '1000', accountId: seed.accountId },
    });
    const payTx = await H.prisma.transaction.findFirstOrThrow({
      where: { workspaceId: ws, orderId: order.id, kind: 'ORDER_PAYMENT' },
    });
    // Чек привязан к ОПЕРАЦИИ (transactionId, orderId=null у вложения).
    const att = await H.prisma.attachment.create({
      data: {
        workspaceId: ws,
        transactionId: payTx.id,
        filename: 'pay-receipt.png',
        mimeType: 'image/png',
        size: 10,
        storagePath: '/nonexistent/pay.png',
        hash: `pay-${tg}`,
      },
    });
    // Удаляем заказ → его платёжные операции soft-deleted, их вложения сняты.
    const del = await H.inject({ method: 'DELETE', url: `/workspaces/${ws}/orders/${order.id}`, token });
    expect(del.statusCode).toBe(200);
    expect(await H.prisma.attachment.findUnique({ where: { id: att.id } })).toBeNull();
  });

  it('негатив: 401 без токена и 403 к чужому workspace', async () => {
    const ws = seed.workspaceId;
    const txId = await seedTransaction();
    const noAuth = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/transactions/${txId}/attachments`,
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
      url: `/workspaces/${otherWs.id}/transactions/${txId}/attachments`,
      token,
    });
    expect(forbidden.statusCode).toBe(403);
  });
});
