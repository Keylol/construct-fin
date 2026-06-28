/**
 * Функциональные тесты экспорта отчётов (CSV/XLSX) — регрессия R3.
 *
 * Через РЕАЛЬНЫЙ Nest+Fastify (buildHttpApp): JwtAuthGuard + WorkspaceGuard +
 * ZodPipe + AllExceptionsFilter — полный прод-пайплайн.
 *
 * Дефект R3: метод export брал ВЕСЬ query (включая `format`) и передавал его в
 * .strict()-схемы отчётов (PnlQuerySchema/CashflowQuerySchema/BreakdownQuerySchema).
 * Лишний ключ `format` (всегда присутствует в URL экспорта) → Zod бросал
 * unrecognized_keys → ни один отчёт нельзя было выгрузить (400/500). Фикс
 * вырезает `format` из объекта до .parse(). Эти тесты до фикса падали.
 *
 * Эндпоинт: GET /workspaces/:wsId/reports/:kind/export?format=csv|xlsx&...
 * Диапазон telegramId: 2710000n+ (не пересекается с другими сьютами).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildHttpApp, type HttpApp } from '../e2e/http-harness';
import { resetDb, seedBase, seedMember, type Seed } from '../test/money-harness';

let H: HttpApp;
let seed: Seed;
let token: string;
let tg = 2710000n;

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

/** Засеивает одну доходную и одну расходную транзакцию в текущем месяце. */
async function seedTwoTransactions(): Promise<void> {
  const now = new Date();
  await H.prisma.transaction.createMany({
    data: [
      {
        workspaceId: seed.workspaceId,
        accountId: seed.accountId,
        date: now,
        amount: '1000.00',
        type: 'INCOME',
        createdById: seed.userId,
      },
      {
        workspaceId: seed.workspaceId,
        accountId: seed.accountId,
        date: now,
        amount: '250.50',
        type: 'EXPENSE',
        createdById: seed.userId,
      },
    ],
  });
}

describe('Функциональный экспорт отчётов (R3: format + .strict)', () => {
  it('GET pnl/export?format=csv&preset=this-month → 200 и непустой CSV', async () => {
    await seedTwoTransactions();
    const ws = seed.workspaceId;
    const res = await H.inject({
      method: 'GET',
      url: `/workspaces/${ws}/reports/pnl/export?format=csv&preset=this-month`,
      token,
    });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).toContain('text/csv');
    // CSV всегда содержит заголовок отчёта + строку колонок → тело непустое.
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body).toContain('P&L');
  });

  it('GET pnl/export с валидным схемным параметром (groupBy) и format → 200', async () => {
    // Проверяем, что вырезается ИМЕННО format, а легитимные ключи схемы проходят.
    const ws = seed.workspaceId;
    const res = await H.inject({
      method: 'GET',
      url: `/workspaces/${ws}/reports/pnl/export?format=csv&preset=this-month&groupBy=quarter`,
      token,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it('GET cashflow/export?format=csv&preset=this-month → 200 и непустой CSV', async () => {
    await seedTwoTransactions();
    const ws = seed.workspaceId;
    const res = await H.inject({
      method: 'GET',
      url: `/workspaces/${ws}/reports/cashflow/export?format=csv&preset=this-month`,
      token,
    });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).toContain('text/csv');
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body).toContain('Cash flow');
  });

  it('GET by-category/export?format=csv&preset=this-month&type=EXPENSE → 200', async () => {
    await seedTwoTransactions();
    const ws = seed.workspaceId;
    const res = await H.inject({
      method: 'GET',
      url: `/workspaces/${ws}/reports/by-category/export?format=csv&preset=this-month&type=EXPENSE`,
      token,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it('GET pnl/export?format=xlsx&preset=this-month → 200 и xlsx content-type', async () => {
    await seedTwoTransactions();
    const ws = seed.workspaceId;
    const res = await H.inject({
      method: 'GET',
      url: `/workspaces/${ws}/reports/pnl/export?format=xlsx&preset=this-month`,
      token,
    });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).toContain('spreadsheetml');
    expect(res.body.length).toBeGreaterThan(0);
  });

  it('GET pnl/export?format=csv (без данных) → всё равно 200 и непустой CSV', async () => {
    const ws = seed.workspaceId;
    const res = await H.inject({
      method: 'GET',
      url: `/workspaces/${ws}/reports/pnl/export?format=csv&preset=this-month`,
      token,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
  });
});
