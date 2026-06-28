/**
 * Функциональные тесты мутаций workspace (Фаза 2.2 — «кнопка → HTTP → БД»).
 *
 * Через РЕАЛЬНЫЙ Nest+Fastify (buildHttpApp): JwtAuthGuard + WorkspaceGuard +
 * ZodPipe + AllExceptionsFilter — полный прод-пайплайн. На каждую мутацию:
 * запрос → проверка HTTP-кода → проверка точных последствий в БД через Prisma.
 *
 * ВАЖНО: POST /workspaces НЕ под :wsId и защищён только JwtAuthGuard (это
 * создание самого пространства). PATCH/DELETE /workspaces/:wsId проходят через
 * WorkspaceGuard и требуют членства + роли (OWNER/ADMIN для PATCH, OWNER для DELETE).
 *
 * Эндпоинты: POST /workspaces · PATCH /workspaces/:wsId · DELETE /workspaces/:wsId.
 * Диапазон telegramId: 2600000n+ (не пересекается с другими сьютами).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildHttpApp, type HttpApp } from '../e2e/http-harness';
import { resetDb, seedBase, seedMember, type Seed } from '../test/money-harness';

let H: HttpApp;
let seed: Seed;
let token: string;
let tg = 2600000n;

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

describe('Функциональные мутации: пространства (workspaces)', () => {
  it('POST /workspaces → 201, создаёт Workspace и членство OWNER в БД', async () => {
    const res = await H.inject({
      method: 'POST',
      url: '/workspaces',
      token,
      payload: { name: 'Новое пространство' },
    });
    expect(res.statusCode).toBe(201);
    const created = res.json<{ id: string; name: string; role: string; ownerId: string }>();
    expect(created.id).toBeTruthy();
    expect(created.role).toBe('OWNER');

    const ws = await H.prisma.workspace.findUniqueOrThrow({ where: { id: created.id } });
    expect(ws.name).toBe('Новое пространство');
    expect(ws.ownerId).toBe(seed.userId);
    expect(ws.deletedAt).toBeNull();

    // create() в одной транзакции заводит и строку членства OWNER.
    const member = await H.prisma.workspaceMember.findUniqueOrThrow({
      where: { workspaceId_userId: { workspaceId: created.id, userId: seed.userId } },
    });
    expect(member.role).toBe('OWNER');
  });

  it('POST /workspaces → 400 на пустом name (ZodPipe), запись не создаётся', async () => {
    const before = await H.prisma.workspace.count();
    const res = await H.inject({
      method: 'POST',
      url: '/workspaces',
      token,
      payload: { name: '   ' }, // trim → '' → min(1) не пройдёт
    });
    expect(res.statusCode).toBe(400);
    const after = await H.prisma.workspace.count();
    expect(after).toBe(before);
  });

  it('PATCH /workspaces/:wsId → 200 и обновляет name в БД', async () => {
    const res = await H.inject({
      method: 'PATCH',
      url: `/workspaces/${seed.workspaceId}`,
      token,
      payload: { name: 'Переименовано' },
    });
    expect(res.statusCode).toBe(200);
    const ws = await H.prisma.workspace.findUniqueOrThrow({ where: { id: seed.workspaceId } });
    expect(ws.name).toBe('Переименовано');
  });

  it('DELETE /workspaces/:wsId → 204 и помечает soft-deleted (deletedAt)', async () => {
    const res = await H.inject({
      method: 'DELETE',
      url: `/workspaces/${seed.workspaceId}`,
      token,
    });
    expect(res.statusCode).toBe(204);
    const ws = await H.prisma.workspace.findUniqueOrThrow({ where: { id: seed.workspaceId } });
    expect(ws.deletedAt).not.toBeNull();
  });

  it('DELETE /workspaces/:wsId → 403 для роли MEMBER (требуется OWNER), запись цела', async () => {
    // Другое пространство, где seed.userId — лишь MEMBER (не владелец).
    const otherWs = await H.prisma.workspace.create({
      data: {
        name: 'Где я не владелец',
        owner: { create: { telegramId: tg + 700000n, username: 'owner2', firstName: 'O2' } },
      },
    });
    await seedMember(H.prisma, otherWs.id, seed.userId, 'MEMBER');

    const res = await H.inject({
      method: 'DELETE',
      url: `/workspaces/${otherWs.id}`,
      token,
    });
    expect(res.statusCode).toBe(403);
    const ws = await H.prisma.workspace.findUniqueOrThrow({ where: { id: otherWs.id } });
    expect(ws.deletedAt).toBeNull();
  });

  it('негатив: 401 без токена и 403 к чужому workspace (нет членства)', async () => {
    const noAuth = await H.inject({ method: 'POST', url: '/workspaces', payload: { name: 'X' } });
    expect(noAuth.statusCode).toBe(401);

    const otherWs = await H.prisma.workspace.create({
      data: {
        name: 'Чужой',
        owner: { create: { telegramId: tg + 500000n, username: 'other', firstName: 'O' } },
      },
    });
    const forbidden = await H.inject({
      method: 'PATCH',
      url: `/workspaces/${otherWs.id}`,
      token,
      payload: { name: 'Z' },
    });
    expect(forbidden.statusCode).toBe(403);
  });
});
