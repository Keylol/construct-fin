/**
 * Функциональные тесты мутаций транзакций (Фаза 2.2 — «кнопка → HTTP → БД»).
 *
 * Через РЕАЛЬНЫЙ Nest+Fastify (buildHttpApp): JwtAuthGuard + WorkspaceGuard +
 * ZodPipe + AllExceptionsFilter — полный прод-пайплайн. На каждую мутацию:
 * запрос → проверка HTTP-кода → проверка точных последствий в БД через Prisma.
 *
 * Эндпоинты: POST /transactions · PATCH /transactions/:id · DELETE /transactions/:id.
 * Деньги — Decimal-строки, сверяем через .toFixed(2) (НИКОГДА number).
 * Диапазон telegramId: 2300000n+ (не пересекается с другими сьютами).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildHttpApp, type HttpApp } from '../e2e/http-harness';
import { resetDb, seedBase, seedMember, type Seed } from '../test/money-harness';

let H: HttpApp;
let seed: Seed;
let token: string;
let tg = 2300000n;

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

describe('Функциональные мутации: транзакции (transactions)', () => {
  it('POST /transactions → 201 и создаёт Transaction в БД с переданными полями', async () => {
    const ws = seed.workspaceId;
    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/transactions`,
      token,
      payload: {
        date: '2026-06-01T00:00:00.000Z',
        amount: '1234.56',
        type: 'EXPENSE',
        kind: 'VARIABLE_COST',
        accountId: seed.accountId,
        description: 'аренда',
      },
    });
    expect(res.statusCode).toBe(201);
    const created = res.json<{ id: string; amount: string; type: string }>();
    expect(created.id).toBeTruthy();
    // money в ответе — строка с двумя знаками (serialize → toFixed(2))
    expect(created.amount).toBe('1234.56');

    const row = await H.prisma.transaction.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.workspaceId).toBe(ws);
    expect(row.amount.toFixed(2)).toBe('1234.56');
    expect(row.type).toBe('EXPENSE');
    expect(row.kind).toBe('VARIABLE_COST');
    expect(row.accountId).toBe(seed.accountId);
    expect(row.description).toBe('аренда');
    expect(row.createdById).toBe(seed.userId);
    expect(row.deletedAt).toBeNull();
  });

  it('POST /transactions → дефолт kind=OTHER, когда kind не передан', async () => {
    const ws = seed.workspaceId;
    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/transactions`,
      token,
      payload: {
        date: '2026-06-02T00:00:00.000Z',
        amount: '500.00',
        type: 'INCOME',
        accountId: seed.accountId,
      },
    });
    expect(res.statusCode).toBe(201);
    const row = await H.prisma.transaction.findUniqueOrThrow({
      where: { id: res.json<{ id: string }>().id },
    });
    expect(row.kind).toBe('OTHER'); // БД-дефолт
    expect(row.type).toBe('INCOME');
    expect(row.amount.toFixed(2)).toBe('500.00');
  });

  it('POST /transactions → 400 на kind, недопустимом для type (superRefine), запись не создаётся', async () => {
    const ws = seed.workspaceId;
    const before = await H.prisma.transaction.count({ where: { workspaceId: ws } });
    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/transactions`,
      token,
      // SALARY — расходный kind, недопустим для INCOME
      payload: {
        date: '2026-06-03T00:00:00.000Z',
        amount: '100.00',
        type: 'INCOME',
        kind: 'SALARY',
        accountId: seed.accountId,
      },
    });
    expect(res.statusCode).toBe(400);
    const after = await H.prisma.transaction.count({ where: { workspaceId: ws } });
    expect(after).toBe(before);
  });

  it('PATCH /transactions/:id → 200 и обновляет поля в БД', async () => {
    const ws = seed.workspaceId;
    const tx = await H.prisma.transaction.create({
      data: {
        workspaceId: ws,
        date: new Date('2026-06-04T00:00:00.000Z'),
        amount: '300.00',
        type: 'EXPENSE',
        kind: 'OTHER',
        accountId: seed.accountId,
        description: 'старое',
        createdById: seed.userId,
      },
    });
    const res = await H.inject({
      method: 'PATCH',
      url: `/workspaces/${ws}/transactions/${tx.id}`,
      token,
      payload: { amount: '350.25', description: 'новое' },
    });
    expect(res.statusCode).toBe(200);
    const row = await H.prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } });
    expect(row.amount.toFixed(2)).toBe('350.25');
    expect(row.description).toBe('новое');
    expect(row.type).toBe('EXPENSE'); // не переданное поле не тронуто
    expect(row.kind).toBe('OTHER');
  });

  it('DELETE /transactions/:id → 204 и помечает запись soft-deleted (deletedAt)', async () => {
    const ws = seed.workspaceId;
    const tx = await H.prisma.transaction.create({
      data: {
        workspaceId: ws,
        date: new Date('2026-06-05T00:00:00.000Z'),
        amount: '42.00',
        type: 'EXPENSE',
        kind: 'OTHER',
        accountId: seed.accountId,
        createdById: seed.userId,
      },
    });
    const res = await H.inject({
      method: 'DELETE',
      url: `/workspaces/${ws}/transactions/${tx.id}`,
      token,
    });
    expect(res.statusCode).toBe(204);
    const row = await H.prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } });
    expect(row.deletedAt).not.toBeNull();
  });

  it('негатив: 401 без токена и 403 к чужому workspace', async () => {
    const ws = seed.workspaceId;
    const noAuth = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/transactions`,
      payload: { date: '2026-06-06T00:00:00.000Z', amount: '1.00', type: 'INCOME', accountId: seed.accountId },
    });
    expect(noAuth.statusCode).toBe(401);

    const otherWs = await H.prisma.workspace.create({
      data: { name: 'Чужой', owner: { create: { telegramId: tg + 500000n, username: 'other', firstName: 'O' } } },
    });
    const forbidden = await H.inject({
      method: 'POST',
      url: `/workspaces/${otherWs.id}/transactions`,
      token,
      payload: { date: '2026-06-06T00:00:00.000Z', amount: '1.00', type: 'INCOME', accountId: seed.accountId },
    });
    expect(forbidden.statusCode).toBe(403);
  });
});
