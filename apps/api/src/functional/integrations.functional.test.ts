/**
 * Функциональные тесты API интеграций (Ф1-C1) через реальный Nest+Fastify.
 * Проверяем: OwnerGuard (только владелец), маскирование токена (наружу не
 * уходит), CRUD подключения, ротацию токена (сброс ERROR), ручной синк
 * (FakeBank в NODE_ENV=test) с созданием строк выписки.
 *
 * Диапазон telegramId: 2600000n+ (не пересекается с другими сьютами).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Role } from '@prisma/client';
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
  await seedMember(H.prisma, seed.workspaceId, seed.userId, Role.OWNER);
  token = await H.jwtFor(seed.userId, tg);
});

const base = () => `/workspaces/${seed.workspaceId}/integrations`;

describe('Интеграции: CRUD + OwnerGuard (Ф1-C1)', () => {
  it('POST → 201, токен зашифрован и наружу не отдаётся (только keyLast4)', async () => {
    const res = await H.inject({
      method: 'POST',
      url: base(),
      token,
      payload: { provider: 'ALFA', accountId: seed.accountId, token: 'super-secret-token-9876' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<Record<string, unknown>>();
    expect(body.keyLast4).toBe('9876');
    expect(body.status).toBe('ACTIVE');
    // Секрет наружу НЕ уходит.
    expect(JSON.stringify(body)).not.toContain('super-secret-token');
    expect(body).not.toHaveProperty('credentialEnc');

    const row = await H.prisma.integrationConnection.findUniqueOrThrow({
      where: { id: body.id as string },
    });
    expect(row.credentialEnc).toContain('v1.'); // зашифровано
    expect(row.credentialEnc).not.toContain('super-secret-token');
  });

  it('POST с чужим accountId → 400', async () => {
    const res = await H.inject({
      method: 'POST',
      url: base(),
      token,
      payload: { provider: 'ALFA', accountId: 'nonexistent', token: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('не-владелец (MEMBER) получает 403 на всех операциях', async () => {
    const memberId = (
      await H.prisma.user.create({ data: { telegramId: tg + 500000n, firstName: 'Опер' } })
    ).id;
    await seedMember(H.prisma, seed.workspaceId, memberId, Role.MEMBER);
    const memberToken = await H.jwtFor(memberId, tg + 500000n);

    const list = await H.inject({ method: 'GET', url: base(), token: memberToken });
    expect(list.statusCode).toBe(403);
    const create = await H.inject({
      method: 'POST',
      url: base(),
      token: memberToken,
      payload: { provider: 'ALFA', accountId: seed.accountId, token: 'x' },
    });
    expect(create.statusCode).toBe(403);
  });

  it('PATCH ротация токена меняет keyLast4 и сбрасывает ERROR', async () => {
    const created = await H.prisma.integrationConnection.create({
      data: {
        workspaceId: seed.workspaceId,
        provider: 'ALFA',
        accountId: seed.accountId,
        credentialEnc: 'v1.a.b.c',
        keyLast4: '0000',
        status: 'ERROR',
        lastSyncError: 'старая ошибка',
        createdById: seed.userId,
      },
    });
    const res = await H.inject({
      method: 'PATCH',
      url: `${base()}/${created.id}`,
      token,
      payload: { token: 'new-rotated-token-4321' },
    });
    expect(res.statusCode).toBe(200);
    const row = await H.prisma.integrationConnection.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.keyLast4).toBe('4321');
    expect(row.status).toBe('ACTIVE');
    expect(row.lastSyncError).toBeNull();
  });

  it('DELETE → 204 и soft-delete (deletedAt + DISABLED)', async () => {
    const created = await H.prisma.integrationConnection.create({
      data: {
        workspaceId: seed.workspaceId,
        provider: 'ALFA',
        accountId: seed.accountId,
        credentialEnc: 'v1.a.b.c',
        keyLast4: '0000',
        createdById: seed.userId,
      },
    });
    const res = await H.inject({ method: 'DELETE', url: `${base()}/${created.id}`, token });
    expect(res.statusCode).toBe(204);
    const row = await H.prisma.integrationConnection.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.deletedAt).not.toBeNull();
    expect(row.status).toBe('DISABLED');
  });

  it('POST /:id/sync → 200 и загружает строки FakeBank (NODE_ENV=test)', async () => {
    const create = await H.inject({
      method: 'POST',
      url: base(),
      token,
      payload: { provider: 'ALFA', accountId: seed.accountId, token: 'tok-for-sync-1111' },
    });
    const connId = create.json<{ id: string }>().id;

    const res = await H.inject({ method: 'POST', url: `${base()}/${connId}/sync`, token });
    expect(res.statusCode).toBe(200);
    const result = res.json<{ fetched: number; created: number }>();
    expect(result.fetched).toBe(4);
    expect(result.created).toBe(4);

    const lines = await H.prisma.bankStatementLine.count({ where: { connectionId: connId } });
    expect(lines).toBe(4);
  });
});
