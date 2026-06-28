/**
 * Функциональные тесты мутаций сверки (Фаза 2.2 — «кнопка → HTTP → БД»).
 *
 * Через РЕАЛЬНЫЙ Nest+Fastify (buildHttpApp): JwtAuthGuard + WorkspaceGuard +
 * ZodPipe + AllExceptionsFilter. На каждую мутацию: запрос → HTTP-код →
 * проверка точных последствий в БД через Prisma.
 *
 * AccountBalanceCheck — append-only снимок ФАКТИЧЕСКОГО остатка счёта на дату.
 * Удаление снимка — ФИЗИЧЕСКОЕ (не soft-delete): это справочная запись без
 * связанных операций (см. reconciliation.service.ts deleteCheck).
 *
 * Эндпоинты: POST /reconciliation/checks · DELETE /reconciliation/checks/:id.
 * Диапазон telegramId: 2610000n+ (не пересекается с другими сьютами).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildHttpApp, type HttpApp } from '../e2e/http-harness';
import { resetDb, seedBase, seedMember, type Seed } from '../test/money-harness';

let H: HttpApp;
let seed: Seed;
let token: string;
let tg = 2610000n;

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

describe('Функциональные мутации: сверка (reconciliation checks)', () => {
  it('POST /reconciliation/checks → 201 и создаёт AccountBalanceCheck в БД', async () => {
    const ws = seed.workspaceId;
    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/reconciliation/checks`,
      token,
      payload: {
        accountId: seed.accountId,
        date: '2026-05-01',
        actualBalance: '1500.50',
        note: 'по выписке',
      },
    });
    expect(res.statusCode).toBe(201);
    const created = res.json<{ id: string; actualBalance: string }>();
    expect(created.id).toBeTruthy();
    expect(created.actualBalance).toBe('1500.50');

    const row = await H.prisma.accountBalanceCheck.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(row.workspaceId).toBe(ws);
    expect(row.accountId).toBe(seed.accountId);
    expect(row.actualBalance.toString()).toBe('1500.5');
    expect(row.note).toBe('по выписке');
    expect(row.createdById).toBe(seed.userId);
    expect(row.date.toISOString().slice(0, 10)).toBe('2026-05-01');
  });

  it('POST /reconciliation/checks → 400 на невалидном actualBalance (3 знака), запись не создаётся', async () => {
    const ws = seed.workspaceId;
    const before = await H.prisma.accountBalanceCheck.count({ where: { workspaceId: ws } });
    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/reconciliation/checks`,
      token,
      payload: { accountId: seed.accountId, date: '2026-05-01', actualBalance: '12.345' },
    });
    expect(res.statusCode).toBe(400);
    const after = await H.prisma.accountBalanceCheck.count({ where: { workspaceId: ws } });
    expect(after).toBe(before);
  });

  it('POST /reconciliation/checks → 404 на счёт другого workspace (assertAccount)', async () => {
    const ws = seed.workspaceId;
    // Счёт в чужом пространстве — валидный cuid, но не принадлежит ws.
    const otherWs = await H.prisma.workspace.create({
      data: {
        name: 'Чужой',
        owner: { create: { telegramId: tg + 600000n, username: 'o3', firstName: 'O3' } },
      },
    });
    const foreignAccount = await H.prisma.account.create({
      data: { workspaceId: otherWs.id, name: 'Чужой счёт', type: 'CASH' },
    });
    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/reconciliation/checks`,
      token,
      payload: { accountId: foreignAccount.id, date: '2026-05-01', actualBalance: '10.00' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('DELETE /reconciliation/checks/:id → 204 и ФИЗИЧЕСКИ удаляет запись', async () => {
    const ws = seed.workspaceId;
    const check = await H.prisma.accountBalanceCheck.create({
      data: {
        workspaceId: ws,
        accountId: seed.accountId,
        date: new Date('2026-05-01'),
        actualBalance: '999.00',
        createdById: seed.userId,
      },
    });
    const res = await H.inject({
      method: 'DELETE',
      url: `/workspaces/${ws}/reconciliation/checks/${check.id}`,
      token,
    });
    expect(res.statusCode).toBe(204);
    // Физическое удаление: строки больше нет (модель без deletedAt).
    const row = await H.prisma.accountBalanceCheck.findUnique({ where: { id: check.id } });
    expect(row).toBeNull();
  });

  it('негатив: 401 без токена и 403 к чужому workspace', async () => {
    const ws = seed.workspaceId;
    const noAuth = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/reconciliation/checks`,
      payload: { accountId: seed.accountId, date: '2026-05-01', actualBalance: '1.00' },
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
      url: `/workspaces/${otherWs.id}/reconciliation/checks`,
      token,
      payload: { accountId: seed.accountId, date: '2026-05-01', actualBalance: '1.00' },
    });
    expect(forbidden.statusCode).toBe(403);
  });
});
