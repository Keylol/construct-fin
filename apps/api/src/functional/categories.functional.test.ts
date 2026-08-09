/**
 * Функциональные тесты мутаций категорий (Фаза 2.2 — «кнопка → HTTP → БД»).
 *
 * Через РЕАЛЬНЫЙ Nest+Fastify (buildHttpApp): JwtAuthGuard + WorkspaceGuard +
 * ZodPipe + AllExceptionsFilter — полный прод-пайплайн. На каждую мутацию:
 * запрос → проверка HTTP-кода → проверка точных последствий в БД через Prisma.
 *
 * Эндпоинты: POST /categories · PATCH /categories/:id · DELETE /categories/:id.
 * Диапазон telegramId: 2200000n+ (не пересекается с другими сьютами).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildHttpApp, type HttpApp } from '../e2e/http-harness';
import { resetDb, seedBase, seedMember, type Seed } from '../test/money-harness';

let H: HttpApp;
let seed: Seed;
let token: string;
let tg = 2200000n;

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

describe('Функциональные мутации: категории (categories)', () => {
  it('POST /categories → 201 и создаёт Category в БД с переданными полями', async () => {
    const ws = seed.workspaceId;
    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/categories`,
      token,
      payload: { name: 'Аренда', kind: 'EXPENSE', bucket: 'FIXED', isFixedCost: true },
    });
    expect(res.statusCode).toBe(201);
    const created = res.json<{ id: string }>();
    expect(created.id).toBeTruthy();

    const row = await H.prisma.category.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.workspaceId).toBe(ws);
    expect(row.name).toBe('Аренда');
    expect(row.kind).toBe('EXPENSE');
    expect(row.bucket).toBe('FIXED');
    expect(row.isFixedCost).toBe(true);
    expect(row.parentId).toBeNull();
    expect(row.isArchived).toBe(false);
    expect(row.deletedAt).toBeNull();
  });

  it('POST /categories → дефолты bucket=OTHER, isFixedCost=false', async () => {
    const ws = seed.workspaceId;
    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/categories`,
      token,
      payload: { name: 'Выручка', kind: 'INCOME' },
    });
    expect(res.statusCode).toBe(201);
    const row = await H.prisma.category.findUniqueOrThrow({ where: { id: res.json<{ id: string }>().id } });
    expect(row.bucket).toBe('OTHER');
    expect(row.isFixedCost).toBe(false);
  });

  it('POST /categories → создаёт подкатегорию с parentId (2 уровня)', async () => {
    const ws = seed.workspaceId;
    const parent = await H.prisma.category.create({
      data: { workspaceId: ws, name: 'Родитель', kind: 'EXPENSE' },
    });
    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/categories`,
      token,
      payload: { name: 'Подкатегория', kind: 'EXPENSE', parentId: parent.id },
    });
    expect(res.statusCode).toBe(201);
    const row = await H.prisma.category.findUniqueOrThrow({ where: { id: res.json<{ id: string }>().id } });
    expect(row.parentId).toBe(parent.id);
  });

  it('POST /categories → 400 на невалидном kind (ZodPipe), запись не создаётся', async () => {
    const ws = seed.workspaceId;
    const before = await H.prisma.category.count({ where: { workspaceId: ws } });
    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/categories`,
      token,
      payload: { name: 'X', kind: 'ASSET' },
    });
    expect(res.statusCode).toBe(400);
    const after = await H.prisma.category.count({ where: { workspaceId: ws } });
    expect(after).toBe(before);
  });

  it('PATCH /categories/:id → 200 и обновляет поля в БД', async () => {
    const ws = seed.workspaceId;
    const cat = await H.prisma.category.create({
      data: { workspaceId: ws, name: 'Старое', kind: 'EXPENSE', bucket: 'OTHER' },
    });
    const res = await H.inject({
      method: 'PATCH',
      url: `/workspaces/${ws}/categories/${cat.id}`,
      token,
      payload: { name: 'Новое', bucket: 'VARIABLE', isArchived: true },
    });
    expect(res.statusCode).toBe(200);
    const row = await H.prisma.category.findUniqueOrThrow({ where: { id: cat.id } });
    expect(row.name).toBe('Новое');
    expect(row.bucket).toBe('VARIABLE');
    expect(row.isArchived).toBe(true);
    expect(row.kind).toBe('EXPENSE'); // kind не меняется через update
  });

  it('DELETE /categories/:id → 204 и помечает запись soft-deleted (deletedAt)', async () => {
    const ws = seed.workspaceId;
    const cat = await H.prisma.category.create({
      data: { workspaceId: ws, name: 'НаУдаление', kind: 'EXPENSE' },
    });
    const res = await H.inject({
      method: 'DELETE',
      url: `/workspaces/${ws}/categories/${cat.id}`,
      token,
    });
    expect(res.statusCode).toBe(204);
    const row = await H.prisma.category.findUniqueOrThrow({ where: { id: cat.id } });
    expect(row.deletedAt).not.toBeNull();
  });

  // Возврат выручки — расход в группе REVENUE. ОПиУ считает выручку как нетто
  // (доход бакета минус его расход), поэтому такая категория УМЕНЬШАЕТ выручку,
  // а не попадает в неё. Прежний запрет делал «Возврат выручки» нередактируемым.
  it('EXPENSE + REVENUE разрешён — это возврат выручки клиенту', async () => {
    const ws = seed.workspaceId;
    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/categories`,
      token,
      payload: { name: 'Возврат выручки', kind: 'EXPENSE', bucket: 'REVENUE' },
    });
    expect(res.statusCode).toBe(201);
    const row = await H.prisma.category.findUniqueOrThrow({
      where: { id: res.json<{ id: string }>().id },
    });
    expect(row.bucket).toBe('REVENUE');
    expect(row.kind).toBe('EXPENSE');
  });

  it('M13: POST /categories → 400 при kind=INCOME + bucket=COGS', async () => {
    const ws = seed.workspaceId;
    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/categories`,
      token,
      payload: { name: 'ДоходВСебестоимость', kind: 'INCOME', bucket: 'COGS' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('M13: POST /categories → 201 для валидных пар (EXPENSE+COGS, INCOME+REVENUE, нейтральный CAPITAL)', async () => {
    const ws = seed.workspaceId;
    for (const payload of [
      { name: 'Себестоимость', kind: 'EXPENSE', bucket: 'COGS' },
      { name: 'Продажи', kind: 'INCOME', bucket: 'REVENUE' },
      { name: 'Взнос учредителя', kind: 'INCOME', bucket: 'CAPITAL' },
      { name: 'Изъятие учредителя', kind: 'EXPENSE', bucket: 'CAPITAL' },
    ]) {
      const res = await H.inject({
        method: 'POST',
        url: `/workspaces/${ws}/categories`,
        token,
        payload,
      });
      expect(res.statusCode).toBe(201);
      const row = await H.prisma.category.findUniqueOrThrow({ where: { id: res.json<{ id: string }>().id } });
      expect(row.bucket).toBe(payload.bucket);
    }
  });

  it('M13: PATCH /categories/:id → 400 при смене bucket на несовместимый с kind, БД не меняется', async () => {
    const ws = seed.workspaceId;
    const cat = await H.prisma.category.create({
      data: { workspaceId: ws, name: 'Доход', kind: 'INCOME', bucket: 'REVENUE' },
    });
    const res = await H.inject({
      method: 'PATCH',
      url: `/workspaces/${ws}/categories/${cat.id}`,
      token,
      payload: { bucket: 'COGS' }, // себестоимость — только расходу
    });
    expect(res.statusCode).toBe(400);
    const row = await H.prisma.category.findUniqueOrThrow({ where: { id: cat.id } });
    expect(row.bucket).toBe('REVENUE');
  });

  it('PATCH: расходной категории можно поставить группу «Выручка» — возврат', async () => {
    const ws = seed.workspaceId;
    const cat = await H.prisma.category.create({
      data: { workspaceId: ws, name: 'Возврат', kind: 'EXPENSE', bucket: 'OTHER' },
    });
    const res = await H.inject({
      method: 'PATCH',
      url: `/workspaces/${ws}/categories/${cat.id}`,
      token,
      payload: { bucket: 'REVENUE' },
    });
    expect(res.statusCode).toBe(200);
    const row = await H.prisma.category.findUniqueOrThrow({ where: { id: cat.id } });
    expect(row.bucket).toBe('REVENUE');
  });

  it('негатив: 401 без токена и 403 к чужому workspace', async () => {
    const ws = seed.workspaceId;
    const noAuth = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/categories`,
      payload: { name: 'Y', kind: 'INCOME' },
    });
    expect(noAuth.statusCode).toBe(401);

    const otherWs = await H.prisma.workspace.create({
      data: { name: 'Чужой', owner: { create: { telegramId: tg + 500000n, username: 'other', firstName: 'O' } } },
    });
    const forbidden = await H.inject({
      method: 'POST',
      url: `/workspaces/${otherWs.id}/categories`,
      token,
      payload: { name: 'Z', kind: 'INCOME' },
    });
    expect(forbidden.statusCode).toBe(403);
  });
});
