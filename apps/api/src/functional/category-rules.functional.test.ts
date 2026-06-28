/**
 * Функциональные тесты мутаций правил категоризации (Фаза 2.2 — «кнопка → HTTP → БД»).
 *
 * Через РЕАЛЬНЫЙ Nest+Fastify (buildHttpApp): JwtAuthGuard + WorkspaceGuard +
 * ZodPipe + AllExceptionsFilter — полный прод-пайплайн. На каждую мутацию:
 * запрос → проверка HTTP-кода → проверка точных последствий в БД через Prisma.
 *
 * Эндпоинты: POST /category-rules · PATCH /category-rules/:id · DELETE /category-rules/:id.
 * Диапазон telegramId: 2220000n+ (не пересекается с другими сьютами).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildHttpApp, type HttpApp } from '../e2e/http-harness';
import { resetDb, seedBase, seedMember, type Seed } from '../test/money-harness';

let H: HttpApp;
let seed: Seed;
let token: string;
let tg = 2220000n;

/** Создаёт категорию в workspace — правило требует валидного categoryId. */
async function seedCategory(workspaceId: string): Promise<string> {
  const cat = await H.prisma.category.create({
    data: { workspaceId, name: 'Категория', kind: 'EXPENSE' },
  });
  return cat.id;
}

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

describe('Функциональные мутации: правила категоризации (category-rules)', () => {
  it('POST /category-rules → 201 и создаёт CategoryRule в БД с переданными полями', async () => {
    const ws = seed.workspaceId;
    const categoryId = await seedCategory(ws);
    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/category-rules`,
      token,
      payload: { keyword: 'аренда', categoryId, priority: 50, isActive: true },
    });
    expect(res.statusCode).toBe(201);
    const created = res.json<{ id: string }>();
    expect(created.id).toBeTruthy();

    const row = await H.prisma.categoryRule.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.workspaceId).toBe(ws);
    expect(row.keyword).toBe('аренда');
    expect(row.categoryId).toBe(categoryId);
    expect(row.priority).toBe(50);
    expect(row.isActive).toBe(true);
    expect(row.deletedAt).toBeNull();
  });

  it('POST /category-rules → дефолты priority=0, isActive=true', async () => {
    const ws = seed.workspaceId;
    const categoryId = await seedCategory(ws);
    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/category-rules`,
      token,
      payload: { keyword: 'такси', categoryId },
    });
    expect(res.statusCode).toBe(201);
    const row = await H.prisma.categoryRule.findUniqueOrThrow({ where: { id: res.json<{ id: string }>().id } });
    expect(row.priority).toBe(0);
    expect(row.isActive).toBe(true);
  });

  it('POST /category-rules → 400 на пустом keyword (ZodPipe), запись не создаётся', async () => {
    const ws = seed.workspaceId;
    const categoryId = await seedCategory(ws);
    const before = await H.prisma.categoryRule.count({ where: { workspaceId: ws } });
    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/category-rules`,
      token,
      payload: { keyword: '', categoryId },
    });
    expect(res.statusCode).toBe(400);
    const after = await H.prisma.categoryRule.count({ where: { workspaceId: ws } });
    expect(after).toBe(before);
  });

  it('POST /category-rules → 400 если категория чужого workspace, запись не создаётся', async () => {
    const ws = seed.workspaceId;
    const before = await H.prisma.categoryRule.count({ where: { workspaceId: ws } });
    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/category-rules`,
      token,
      payload: { keyword: 'офис', categoryId: 'cat_does_not_exist' },
    });
    expect(res.statusCode).toBe(400);
    const after = await H.prisma.categoryRule.count({ where: { workspaceId: ws } });
    expect(after).toBe(before);
  });

  it('PATCH /category-rules/:id → 200 и обновляет поля в БД', async () => {
    const ws = seed.workspaceId;
    const categoryId = await seedCategory(ws);
    const rule = await H.prisma.categoryRule.create({
      data: { workspaceId: ws, keyword: 'старое', categoryId, priority: 0, isActive: true },
    });
    const res = await H.inject({
      method: 'PATCH',
      url: `/workspaces/${ws}/category-rules/${rule.id}`,
      token,
      payload: { keyword: 'новое', priority: 100, isActive: false },
    });
    expect(res.statusCode).toBe(200);
    const row = await H.prisma.categoryRule.findUniqueOrThrow({ where: { id: rule.id } });
    expect(row.keyword).toBe('новое');
    expect(row.priority).toBe(100);
    expect(row.isActive).toBe(false);
    expect(row.categoryId).toBe(categoryId); // не переданное поле не тронуто
  });

  it('DELETE /category-rules/:id → 204 и помечает запись soft-deleted (deletedAt, isActive=false)', async () => {
    const ws = seed.workspaceId;
    const categoryId = await seedCategory(ws);
    const rule = await H.prisma.categoryRule.create({
      data: { workspaceId: ws, keyword: 'на_удаление', categoryId, isActive: true },
    });
    const res = await H.inject({
      method: 'DELETE',
      url: `/workspaces/${ws}/category-rules/${rule.id}`,
      token,
    });
    expect(res.statusCode).toBe(204);
    const row = await H.prisma.categoryRule.findUniqueOrThrow({ where: { id: rule.id } });
    expect(row.deletedAt).not.toBeNull();
    expect(row.isActive).toBe(false);
  });

  it('негатив: 401 без токена и 403 к чужому workspace', async () => {
    const ws = seed.workspaceId;
    const categoryId = await seedCategory(ws);
    const noAuth = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/category-rules`,
      payload: { keyword: 'y', categoryId },
    });
    expect(noAuth.statusCode).toBe(401);

    const otherWs = await H.prisma.workspace.create({
      data: { name: 'Чужой', owner: { create: { telegramId: tg + 500000n, username: 'other', firstName: 'O' } } },
    });
    const forbidden = await H.inject({
      method: 'POST',
      url: `/workspaces/${otherWs.id}/category-rules`,
      token,
      payload: { keyword: 'z', categoryId },
    });
    expect(forbidden.statusCode).toBe(403);
  });
});
