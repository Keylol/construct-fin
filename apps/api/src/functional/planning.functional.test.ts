/**
 * Функциональные тесты Ф5 (регулярка + плановые платежи): «кнопка → HTTP → БД».
 * POST/GET /planning/recurring · /planning/planned · /planning/planned/:id/pay ·
 * /planning/upcoming · /planning/count. Диапазон telegramId: 3300000n+.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildHttpApp, type HttpApp } from '../e2e/http-harness';
import { resetDb, seedBase, seedMember, type Seed } from '../test/money-harness';

let H: HttpApp;
let seed: Seed;
let token: string;
let tg = 3_300_000n;

const DAY = 86_400_000;
const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();

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

describe('Функциональные мутации: планирование (planning)', () => {
  it('POST recurring → 201, GET recurring → список с nextDueDate', async () => {
    const ws = seed.workspaceId;
    const create = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/planning/recurring`,
      token,
      payload: {
        title: 'Аренда',
        amount: '30000.00',
        txKind: 'FIXED_COST',
        cadence: 'MONTHLY',
        dayOfMonth: 5,
        startDate: iso(-60 * DAY),
        accountId: seed.accountId,
      },
    });
    expect(create.statusCode).toBe(201);

    const list = await H.inject({ method: 'GET', url: `/workspaces/${ws}/planning/recurring`, token });
    expect(list.statusCode).toBe(200);
    const rows = list.json<{ title: string; amount: string; nextDueDate: string | null }[]>();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe('Аренда');
    expect(rows[0]!.amount).toBe('30000.00');
    expect(rows[0]!.nextDueDate).not.toBeNull();
  });

  it('POST planned → upcoming показывает; pay создаёт проводку; count считает', async () => {
    const ws = seed.workspaceId;
    const create = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/planning/planned`,
      token,
      payload: {
        title: 'Интернет',
        amount: '1500.00',
        txKind: 'FIXED_COST',
        dueDate: iso(-1 * DAY),
        source: 'MANUAL',
        leadDays: 3,
      },
    });
    expect(create.statusCode).toBe(201);
    const planId = create.json<{ id: string }>().id;

    const up = await H.inject({ method: 'GET', url: `/workspaces/${ws}/planning/upcoming?horizonDays=30`, token });
    expect(up.statusCode).toBe(200);
    const upBody = up.json<{ items: { id: string; overdue: boolean }[]; overdueCount: number }>();
    expect(upBody.items.some((i) => i.id === planId && i.overdue)).toBe(true);
    expect(upBody.overdueCount).toBe(1);

    const pay = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/planning/planned/${planId}/pay`,
      token,
      payload: { accountId: seed.accountId, amount: '1500.00', date: iso(-1 * DAY) },
    });
    expect(pay.statusCode).toBe(201);
    const txId = pay.json<{ transactionId: string }>().transactionId;
    const tx = await H.prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(tx.kind).toBe('FIXED_COST');
    expect(tx.amount.toFixed(2)).toBe('1500.00');

    // Оплаченный уходит из «горит»; счётчик обнуляется.
    const cnt = await H.inject({ method: 'GET', url: `/workspaces/${ws}/planning/count`, token });
    expect(cnt.json<{ count: number }>().count).toBe(0);
  });

  it('валидация: MONTHLY без dayOfMonth → 400; SALARY без сотрудника → 400', async () => {
    const ws = seed.workspaceId;
    const badRec = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/planning/recurring`,
      token,
      payload: { title: 'X', amount: '1.00', cadence: 'MONTHLY', startDate: iso(0) },
    });
    expect(badRec.statusCode).toBe(400);

    const badSalary = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/planning/planned`,
      token,
      payload: { title: 'ЗП', amount: '1000.00', dueDate: iso(0), source: 'SALARY' },
    });
    expect(badSalary.statusCode).toBe(400);
  });

  it('без токена → 401, чужой workspace → 403', async () => {
    const ws = seed.workspaceId;
    const noAuth = await H.inject({ method: 'GET', url: `/workspaces/${ws}/planning/recurring` });
    expect(noAuth.statusCode).toBe(401);

    const stranger = await seedBase(H.prisma, tg + 500_000n);
    const strangerToken = await H.jwtFor(stranger.userId, tg + 500_000n);
    const foreign = await H.inject({
      method: 'GET',
      url: `/workspaces/${ws}/planning/recurring`,
      token: strangerToken,
    });
    expect(foreign.statusCode).toBe(403);
  });
});
