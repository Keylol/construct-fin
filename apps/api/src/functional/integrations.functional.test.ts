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
      payload: {
        provider: 'ALFA',
        accountId: seed.accountId,
        token: 'super-secret-token-9876',
        accountNumber: '40802810401300015422',
      },
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

  it('сертификат без ключа → 400 (загружаются только парой)', async () => {
    const res = await H.inject({
      method: 'POST',
      url: base(),
      token,
      payload: {
        provider: 'ALFA',
        accountId: seed.accountId,
        token: 'tok-1111',
        accountNumber: '40802810401300015422',
        tlsCert: '-----BEGIN CERTIFICATE-----\nZm9v\n-----END CERTIFICATE-----',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('битый сертификат отклоняется до сохранения подключения', async () => {
    const before = await H.prisma.integrationConnection.count();
    const res = await H.inject({
      method: 'POST',
      url: base(),
      token,
      payload: {
        provider: 'ALFA',
        accountId: seed.accountId,
        token: 'tok-2222',
        accountNumber: '40802810401300015422',
        tlsCert: '-----BEGIN CERTIFICATE-----\nне-base64!!!\n-----END CERTIFICATE-----',
        tlsKey: '-----BEGIN PRIVATE KEY-----\nZm9v\n-----END PRIVATE KEY-----',
      },
    });
    expect(res.statusCode).toBe(400);
    // Подключение с непригодным сертификатом не должно оседать в базе.
    expect(await H.prisma.integrationConnection.count()).toBe(before);
  });

  it('Альфа без номера расчётного счёта → 400 (Ф2: без него выписку не запросить)', async () => {
    const res = await H.inject({
      method: 'POST',
      url: base(),
      token,
      payload: { provider: 'ALFA', accountId: seed.accountId, token: 'tok-0000' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('номер счёта возвращается в ответе и меняется PATCH-ем со сбросом курсора', async () => {
    const created = await H.prisma.integrationConnection.create({
      data: {
        workspaceId: seed.workspaceId,
        provider: 'ALFA',
        accountId: seed.accountId,
        credentialEnc: 'v1.a.b.c',
        keyLast4: '0000',
        externalAccountId: '40802810401300015422',
        syncCursor: '2026-07-20',
        createdById: seed.userId,
      },
    });

    const list = await H.inject({ method: 'GET', url: base(), token });
    expect(list.json<{ accountNumber: string }[]>()[0]!.accountNumber).toBe('40802810401300015422');

    const res = await H.inject({
      method: 'PATCH',
      url: `${base()}/${created.id}`,
      token,
      payload: { accountNumber: '40802810401300019999' },
    });
    expect(res.statusCode).toBe(200);
    const row = await H.prisma.integrationConnection.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(row.externalAccountId).toBe('40802810401300019999');
    // Другой счёт — другой источник строк: курсор прошлого счёта сброшен.
    expect(row.syncCursor).toBeNull();
  });

  it('дата выгрузки: сдвиг назад сбрасывает курсор, вперёд — нет, будущее → 400', async () => {
    const created = await H.prisma.integrationConnection.create({
      data: {
        workspaceId: seed.workspaceId,
        provider: 'ALFA',
        accountId: seed.accountId,
        credentialEnc: 'v1.a.b.c',
        keyLast4: '0000',
        externalAccountId: '40802810401300015422',
        backfillFrom: new Date('2026-06-01T00:00:00Z'),
        syncCursor: '2026-07-20',
        createdById: seed.userId,
      },
    });
    const patch = (backfillFrom: string) =>
      H.inject({
        method: 'PATCH',
        url: `${base()}/${created.id}`,
        token,
        payload: { backfillFrom },
      });
    const row = () =>
      H.prisma.integrationConnection.findUniqueOrThrow({ where: { id: created.id } });

    // Назад: прошлое ещё не загружено, курсор обязан обнулиться — иначе синк
    // продолжит с уже пройденного места и история не приедет.
    expect((await patch('2026-05-01')).statusCode).toBe(200);
    const back = await row();
    expect(back.backfillFrom?.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    expect(back.syncCursor).toBeNull();

    // Вперёд: загруженное остаётся на месте, курсор не трогаем.
    await H.prisma.integrationConnection.update({
      where: { id: created.id },
      data: { syncCursor: '2026-07-25' },
    });
    expect((await patch('2026-06-15')).statusCode).toBe(200);
    expect((await row()).syncCursor).toBe('2026-07-25');

    // Выписки за завтра не существует.
    expect((await patch('2027-01-01')).statusCode).toBe(400);
  });

  it('POST с чужим accountId → 400', async () => {
    const res = await H.inject({
      method: 'POST',
      url: base(),
      token,
      payload: {
        provider: 'ALFA',
        accountId: 'nonexistent',
        token: 'x',
        accountNumber: '40802810401300015422',
      },
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
      payload: {
        provider: 'ALFA',
        accountId: seed.accountId,
        token: 'x',
        accountNumber: '40802810401300015422',
      },
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
      payload: {
        provider: 'ALFA',
        accountId: seed.accountId,
        token: 'tok-for-sync-1111',
        accountNumber: '40802810401300015422',
      },
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
