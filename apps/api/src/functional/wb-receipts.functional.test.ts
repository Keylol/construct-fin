/**
 * Функциональные тесты разбора чека WB (Ф6): «кнопка → HTTP → БД» через
 * реальный Nest+Fastify. Превью — multipart с НАСТОЯЩЕЙ синтетической
 * PDF-фикстурой (тот же файл, что в юнитах парсера); commit/revert — JSON.
 *
 * Эндпоинты: POST /wb-receipts/preview · POST /wb-receipts ·
 * GET /wb-receipts · DELETE /wb-receipts/:id.
 * Диапазон telegramId: 2720000n+ (не пересекается с другими сьютами).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildHttpApp, type HttpApp } from '../e2e/http-harness';
import { resetDb, seedBase, seedMember, type Seed } from '../test/money-harness';

let H: HttpApp;
let seed: Seed;
let token: string;
let tg = 2720000n;

const SYNTH_PDF = readFileSync(
  resolve(__dirname, '../../../../fixtures/imports/wb-receipt-synth.pdf'),
);

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

function multipartPdf() {
  const boundary = 'XbCyWbReceiptBoundary';
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="receipt.pdf"\r\n` +
        `Content-Type: application/pdf\r\n\r\n`,
    ),
    SYNTH_PDF,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { boundary, body };
}

/** Валидное commit-тело: все 3 позиции синт-чека размечены «пропустить». */
function commitBody(over: Record<string, unknown> = {}) {
  return {
    accountId: seed.accountId,
    money: { mode: 'create', categoryId: null },
    fpd: '1234567890',
    fd: '16669',
    checkNumber: '1471',
    receiptDate: '2026-05-21T03:25:00.000Z',
    totalAmount: '27226.00',
    lines: [
      { name: 'Вентилятор корпусной 120мм ARGB', qty: '3', unitPrice: '590.00', target: 'SKIPPED' },
      { name: '1stCorp Блок питания 850W (тест)', qty: '1', unitPrice: '7018.00', target: 'SKIPPED' },
      { name: 'Процессор для ПК (тест) Core X', qty: '1', unitPrice: '18438.00', target: 'SKIPPED' },
    ],
    ...over,
  };
}

describe('Функциональные мутации: разбор чека WB (wb-receipts)', () => {
  it('POST /wb-receipts/preview → 201: позиции, кандидат-операция, ничего в БД', async () => {
    const ws = seed.workspaceId;
    // Существующая операция карты с суммой чека и датой рядом — кандидат.
    const candidate = await H.prisma.transaction.create({
      data: {
        workspaceId: ws,
        accountId: seed.accountId,
        date: new Date('2026-05-20T00:00:00.000Z'),
        amount: '27226.00',
        type: 'EXPENSE',
        kind: 'OTHER',
        createdById: seed.userId,
      },
      select: { id: true },
    });

    const { boundary, body } = multipartPdf();
    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/wb-receipts/preview?accountId=${seed.accountId}`,
      token,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    const preview = res.json<{
      receipt: {
        fpd: string | null;
        totalAmount: string | null;
        receiptDate: string | null;
        items: { name: string; qty: string }[];
        warnings: string[];
      };
      candidates: { id: string }[];
      alreadyImported: { receiptId: string } | null;
    }>();
    expect(preview.receipt.fpd).toBe('1234567890');
    expect(preview.receipt.totalAmount).toBe('27226.00');
    expect(preview.receipt.items).toHaveLength(3);
    expect(preview.receipt.warnings).toEqual([]);
    expect(preview.candidates.map((c) => c.id)).toContain(candidate.id);
    expect(preview.alreadyImported).toBeNull();

    // Превью ничего не пишет.
    expect(await H.prisma.wbReceipt.count({ where: { workspaceId: ws } })).toBe(0);
  });

  it('commit → 201 (деньги+чек), повтор ФПД → 409, GET list, DELETE revert → 200', async () => {
    const ws = seed.workspaceId;

    const created = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/wb-receipts`,
      token,
      payload: commitBody(),
    });
    expect(created.statusCode).toBe(201);
    const receipt = created.json<{ id: string; transaction: { id: string } }>();
    expect(
      (await H.prisma.transaction.findUniqueOrThrow({ where: { id: receipt.transaction.id } }))
        .amount.toFixed(2),
    ).toBe('27226.00');

    const dup = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/wb-receipts`,
      token,
      payload: commitBody(),
    });
    expect(dup.statusCode).toBe(409);

    const list = await H.inject({
      method: 'GET',
      url: `/workspaces/${ws}/wb-receipts`,
      token,
    });
    expect(list.statusCode).toBe(200);
    const rows = list.json<{ id: string; deletedAt: string | null }[]>();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(receipt.id);

    const reverted = await H.inject({
      method: 'DELETE',
      url: `/workspaces/${ws}/wb-receipts/${receipt.id}`,
      token,
    });
    expect(reverted.statusCode).toBe(200);
    expect(
      (await H.prisma.transaction.findUniqueOrThrow({ where: { id: receipt.transaction.id } }))
        .deletedAt,
    ).not.toBeNull();
  });

  it('Σ строк ≠ итогу → 400; кривой target-набор → 400 (zod)', async () => {
    const ws = seed.workspaceId;
    const badSum = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/wb-receipts`,
      token,
      payload: commitBody({ totalAmount: '1.00' }),
    });
    expect(badSum.statusCode).toBe(400);

    const badLine = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/wb-receipts`,
      token,
      payload: commitBody({
        lines: [
          // WAREHOUSE без товара и без newItem — отсекает superRefine.
          { name: 'X', qty: '1', unitPrice: '27226.00', target: 'WAREHOUSE' },
        ],
      }),
    });
    expect(badLine.statusCode).toBe(400);
  });

  it('без токена → 401, чужой workspace → 403', async () => {
    const ws = seed.workspaceId;
    const noAuth = await H.inject({
      method: 'GET',
      url: `/workspaces/${ws}/wb-receipts`,
    });
    expect(noAuth.statusCode).toBe(401);

    const stranger = await seedBase(H.prisma, tg + 500_000n);
    const strangerToken = await H.jwtFor(stranger.userId, tg + 500_000n);
    const foreign = await H.inject({
      method: 'GET',
      url: `/workspaces/${ws}/wb-receipts`,
      token: strangerToken,
    });
    expect(foreign.statusCode).toBe(403);
  });
});
