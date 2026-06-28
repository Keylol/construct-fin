/**
 * Функциональные тесты импорта (Фаза 2.2 — «кнопка → HTTP → БД»).
 *
 * Через РЕАЛЬНЫЙ Nest+Fastify (buildHttpApp): JwtAuthGuard + WorkspaceGuard +
 * ZodPipe + AllExceptionsFilter. На каждую мутацию: запрос → HTTP-код →
 * проверка точных последствий в БД через Prisma.
 *
 * - POST /import/preview принимает ТОЛЬКО multipart/form-data (файл) и НИЧЕГО не
 *   пишет в БД (только разбор + аннотации). Проверяем 201 и отсутствие записей.
 * - POST /import/commit принимает JSON {filename, fileHash, source, accountId,
 *   skipDuplicates, rows[]} и создаёт ImportBatch + Transaction[] (createMany).
 *
 * Эндпоинты: POST /import/preview · POST /import/commit.
 * Диапазон telegramId: 2620000n+ (не пересекается с другими сьютами).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildHttpApp, type HttpApp } from '../e2e/http-harness';
import { resetDb, seedBase, seedMember, type Seed } from '../test/money-harness';

let H: HttpApp;
let seed: Seed;
let token: string;
let tg = 2620000n;

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

/** Тело commit-запроса (один валидный INCOME-ряд). */
function commitBody(over: Record<string, unknown> = {}) {
  return {
    filename: 'statement.csv',
    fileHash: `FILE-${tg}`,
    source: 'GENERIC_CSV',
    accountId: seed.accountId,
    skipDuplicates: true,
    rows: [
      {
        date: '2026-05-01',
        amount: '100.00',
        type: 'INCOME',
        description: 'оплата',
        counterpartyName: null,
        categoryId: null,
        importHash: `row-${tg}-1`,
        isDuplicate: false,
      },
    ],
    ...over,
  };
}

describe('Функциональные мутации: импорт (import)', () => {
  it('POST /import/commit → 201 и создаёт ImportBatch + Transaction в БД', async () => {
    const ws = seed.workspaceId;
    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/import/commit`,
      token,
      payload: commitBody(),
    });
    expect(res.statusCode).toBe(201);
    const out = res.json<{ batchId: string; imported: number; skipped: number }>();
    expect(out.imported).toBe(1);
    expect(out.skipped).toBe(0);

    const batch = await H.prisma.importBatch.findUniqueOrThrow({ where: { id: out.batchId } });
    expect(batch.workspaceId).toBe(ws);
    expect(batch.userId).toBe(seed.userId);
    expect(batch.source).toBe('GENERIC_CSV');
    expect(batch.filename).toBe('statement.csv');
    expect(batch.rowsTotal).toBe(1);
    expect(batch.rowsImported).toBe(1);
    expect(batch.rowsSkipped).toBe(0);

    const txs = await H.prisma.transaction.findMany({ where: { importBatchId: out.batchId } });
    expect(txs).toHaveLength(1);
    expect(txs[0]!.accountId).toBe(seed.accountId);
    expect(txs[0]!.type).toBe('INCOME');
    expect(txs[0]!.amount.toString()).toBe('100');
    expect(txs[0]!.importHash).toBe(`row-${tg}-1`);
    expect(txs[0]!.createdById).toBe(seed.userId);
  });

  it('POST /import/commit → 400 когда все строки — дубликаты (нечего импортировать)', async () => {
    const ws = seed.workspaceId;
    const before = await H.prisma.importBatch.count({ where: { workspaceId: ws } });
    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/import/commit`,
      token,
      payload: commitBody({
        rows: [
          {
            date: '2026-05-01',
            amount: '100.00',
            type: 'INCOME',
            description: 'дубль',
            counterpartyName: null,
            categoryId: null,
            importHash: `row-${tg}-dup`,
            isDuplicate: true,
          },
        ],
      }),
    });
    expect(res.statusCode).toBe(400);
    // Ни батча, ни транзакций не создано.
    const after = await H.prisma.importBatch.count({ where: { workspaceId: ws } });
    expect(after).toBe(before);
    expect(await H.prisma.transaction.count({ where: { workspaceId: ws } })).toBe(0);
  });

  it('POST /import/commit → 400 на пустом rows[] (ZodPipe min(1))', async () => {
    const ws = seed.workspaceId;
    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/import/commit`,
      token,
      payload: commitBody({ rows: [] }),
    });
    expect(res.statusCode).toBe(400);
    expect(await H.prisma.importBatch.count({ where: { workspaceId: ws } })).toBe(0);
  });

  it('POST /import/preview → 201 (multipart CSV) и НИЧЕГО не пишет в БД', async () => {
    const ws = seed.workspaceId;
    const csv = 'Дата;Сумма;Тип;Описание\r\n2026-05-01;100.00;Приход;оплата\r\n';
    const boundary = 'XbCyImportPreviewBoundary';
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="statement.csv"\r\n` +
          `Content-Type: text/csv\r\n\r\n`,
      ),
      Buffer.from(csv, 'utf-8'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const mapping = encodeURIComponent(
      JSON.stringify({ date: 'Дата', amount: 'Сумма', type: 'Тип', description: 'Описание' }),
    );

    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/import/preview?accountId=${seed.accountId}&source=GENERIC_CSV&mapping=${mapping}`,
      token,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    const preview = res.json<{ stats: { total: number; valid: number } }>();
    expect(preview.stats.total).toBe(1);

    // preview не пишет ничего в БД.
    expect(await H.prisma.importBatch.count({ where: { workspaceId: ws } })).toBe(0);
    expect(await H.prisma.transaction.count({ where: { workspaceId: ws } })).toBe(0);
  });

  it('POST /import/preview → 400 без multipart (обычный JSON)', async () => {
    const ws = seed.workspaceId;
    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/import/preview?accountId=${seed.accountId}`,
      token,
      payload: { not: 'multipart' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('негатив: 401 без токена и 403 к чужому workspace', async () => {
    const ws = seed.workspaceId;
    const noAuth = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/import/commit`,
      payload: commitBody(),
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
      url: `/workspaces/${otherWs.id}/import/commit`,
      token,
      payload: commitBody(),
    });
    expect(forbidden.statusCode).toBe(403);
  });
});
