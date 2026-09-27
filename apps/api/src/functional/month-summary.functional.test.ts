/**
 * Функциональные тесты «Итогов месяца»: GET /reports/month-summary через HTTP
 * (гварды, валидация месяца, роль оператора). Цифры отчёта проверяет
 * reports/month-summary.integration.test.ts.
 * Диапазон telegramId: 4110000n+.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Role } from '@prisma/client';
import { buildHttpApp, type HttpApp } from '../e2e/http-harness';
import { resetDb, seedBase, seedMember, type Seed } from '../test/money-harness';
import { lastClosedMonth } from '../reports/month-summary.calc';

let H: HttpApp;
let seed: Seed;
let token: string;
let tg = 4_110_000n;

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

const url = (qs = '') => `/workspaces/${seed.workspaceId}/reports/month-summary${qs}`;

describe('GET /reports/month-summary', () => {
  it('месяц из запроса: продажи и прибыль по закрытому заказу', async () => {
    await H.prisma.order.create({
      data: {
        workspaceId: seed.workspaceId,
        number: 'MSF-1',
        status: 'DONE',
        closedAt: new Date('2025-03-15T07:00:00.000Z'),
        subtotal: '10000.00',
        totalAmount: '10000.00',
        items: {
          create: [
            { name: 'ПК', qty: '1', unitPrice: '10000.00', lineTotal: '10000.00', unitCostAtSale: '7000.0000' },
          ],
        },
      },
    });

    const res = await H.inject({ method: 'GET', url: url('?month=2025-03'), token });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      month: string;
      ordersClosed: number;
      sales: string;
      components: string;
      net: string;
      checks: { identity: { ok: boolean } };
    }>();
    expect(body).toMatchObject({
      month: '2025-03',
      ordersClosed: 1,
      sales: '10000.00',
      components: '7000.00',
      net: '3000.00',
    });
    expect(body.checks.identity.ok).toBe(true);
  });

  it('без месяца — прошлый законченный месяц', async () => {
    const res = await H.inject({ method: 'GET', url: url(), token });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ month: string }>().month).toBe(lastClosedMonth());
  });

  it('кривой месяц и лишний параметр — 400', async () => {
    for (const qs of ['?month=2025-13', '?month=202503', '?month=1999-12', '?month=2025-03&from=2025-03-01']) {
      const res = await H.inject({ method: 'GET', url: url(qs), token });
      expect(res.statusCode, qs).toBe(400);
    }
  });

  it('оператору отчёт доступен', async () => {
    const opTg = tg + 500n;
    const op = await H.prisma.user.create({ data: { telegramId: opTg, firstName: 'Оператор' } });
    await seedMember(H.prisma, seed.workspaceId, op.id, Role.MEMBER);
    const opToken = await H.jwtFor(op.id, opTg);
    const res = await H.inject({ method: 'GET', url: url('?month=2025-03'), token: opToken });
    expect(res.statusCode).toBe(200);
  });
});
