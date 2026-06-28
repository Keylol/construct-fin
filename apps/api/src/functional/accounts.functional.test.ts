/**
 * Функциональные тесты мутаций счетов (Фаза 2.2 — «кнопка → HTTP → БД»).
 *
 * Через РЕАЛЬНЫЙ Nest+Fastify (buildHttpApp): JwtAuthGuard + WorkspaceGuard +
 * ZodPipe + AllExceptionsFilter — полный прод-пайплайн. На каждую мутацию:
 * запрос → проверка HTTP-кода → проверка точных последствий в БД через Prisma.
 *
 * Эндпоинты: POST /accounts · PATCH /accounts/:id · DELETE /accounts/:id.
 * Диапазон telegramId: 2100000n+ (не пересекается с другими сьютами).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildHttpApp, type HttpApp } from '../e2e/http-harness';
import { resetDb, seedBase, seedMember, type Seed } from '../test/money-harness';

let H: HttpApp;
let seed: Seed;
let token: string;
let tg = 2100000n;

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

describe('Функциональные мутации: счета (accounts)', () => {
  it('POST /accounts → 201 и создаёт Account в БД с переданными полями', async () => {
    const ws = seed.workspaceId;
    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/accounts`,
      token,
      payload: { name: 'Расчётный', type: 'BANK', class: 'OPERATING', openingBalance: '1500.50', note: 'осн.' },
    });
    expect(res.statusCode).toBe(201);
    const created = res.json<{ id: string; name: string; type: string }>();
    expect(created.id).toBeTruthy();

    const row = await H.prisma.account.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.workspaceId).toBe(ws);
    expect(row.name).toBe('Расчётный');
    expect(row.type).toBe('BANK');
    expect(row.class).toBe('OPERATING');
    expect(row.openingBalance.toString()).toBe('1500.5');
    expect(row.note).toBe('осн.');
    expect(row.deletedAt).toBeNull();
  });

  it('POST /accounts → дефолты class=OPERATING, openingBalance=0', async () => {
    const ws = seed.workspaceId;
    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/accounts`,
      token,
      payload: { name: 'Касса', type: 'CASH' },
    });
    expect(res.statusCode).toBe(201);
    const row = await H.prisma.account.findUniqueOrThrow({ where: { id: res.json<{ id: string }>().id } });
    expect(row.class).toBe('OPERATING');
    expect(row.openingBalance.toString()).toBe('0');
  });

  it('POST /accounts → 400 на невалидном type (ZodPipe), запись не создаётся', async () => {
    const ws = seed.workspaceId;
    const before = await H.prisma.account.count({ where: { workspaceId: ws } });
    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/accounts`,
      token,
      payload: { name: 'X', type: 'CRYPTO' },
    });
    expect(res.statusCode).toBe(400);
    const after = await H.prisma.account.count({ where: { workspaceId: ws } });
    expect(after).toBe(before);
  });

  it('PATCH /accounts/:id → 200 и обновляет поля в БД', async () => {
    const ws = seed.workspaceId;
    const acc = await H.prisma.account.create({
      data: { workspaceId: ws, name: 'Старое', type: 'CASH', openingBalance: '0' },
    });
    const res = await H.inject({
      method: 'PATCH',
      url: `/workspaces/${ws}/accounts/${acc.id}`,
      token,
      payload: { name: 'Новое', isArchived: true },
    });
    expect(res.statusCode).toBe(200);
    const row = await H.prisma.account.findUniqueOrThrow({ where: { id: acc.id } });
    expect(row.name).toBe('Новое');
    expect(row.isArchived).toBe(true);
    expect(row.type).toBe('CASH'); // не переданное поле не тронуто
  });

  it('DELETE /accounts/:id → 204 и помечает запись soft-deleted (deletedAt)', async () => {
    const ws = seed.workspaceId;
    const acc = await H.prisma.account.create({
      data: { workspaceId: ws, name: 'НаУдаление', type: 'CASH', openingBalance: '0' },
    });
    const res = await H.inject({
      method: 'DELETE',
      url: `/workspaces/${ws}/accounts/${acc.id}`,
      token,
    });
    expect(res.statusCode).toBe(204);
    const row = await H.prisma.account.findUniqueOrThrow({ where: { id: acc.id } });
    expect(row.deletedAt).not.toBeNull();
  });

  it('негатив: 401 без токена и 403 к чужому workspace', async () => {
    const ws = seed.workspaceId;
    const noAuth = await H.inject({ method: 'POST', url: `/workspaces/${ws}/accounts`, payload: { name: 'Y', type: 'CASH' } });
    expect(noAuth.statusCode).toBe(401);

    // чужой workspace: другой пользователь без членства
    const otherWs = await H.prisma.workspace.create({
      data: { name: 'Чужой', owner: { create: { telegramId: tg + 500000n, username: 'other', firstName: 'O' } } },
    });
    const forbidden = await H.inject({
      method: 'POST',
      url: `/workspaces/${otherWs.id}/accounts`,
      token,
      payload: { name: 'Z', type: 'CASH' },
    });
    expect(forbidden.statusCode).toBe(403);
  });
});
