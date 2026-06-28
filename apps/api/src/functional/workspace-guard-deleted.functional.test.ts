/**
 * Функциональный тест безопасности WorkspaceGuard (дефект R1, multi-tenant).
 *
 * Через РЕАЛЬНЫЙ Nest+Fastify (buildHttpApp): JwtAuthGuard + WorkspaceGuard +
 * AllExceptionsFilter — полный прод-пайплайн.
 *
 * Проверяет, что после soft-delete workspace (Workspace.deletedAt) вложенные
 * ресурсы перестают быть доступны по прямым URL: активный ws → 2xx как раньше,
 * soft-deleted ws → 403 Forbidden (консистентно с остальными отказами guard).
 *
 * Диапазон telegramId: 2700000n+ (не пересекается с другими сьютами).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildHttpApp, type HttpApp } from '../e2e/http-harness';
import { resetDb, seedBase, seedMember, type Seed } from '../test/money-harness';

let H: HttpApp;
let seed: Seed;
let token: string;
let tg = 2700000n;

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

describe('WorkspaceGuard: soft-deleted workspace (R1)', () => {
  it('активный workspace → доступ к вложенному ресурсу проходит (201)', async () => {
    const ws = seed.workspaceId;
    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/accounts`,
      token,
      payload: { name: 'Расчётный', type: 'BANK' },
    });
    expect(res.statusCode).toBe(201);
  });

  it('soft-deleted workspace → POST к вложенному ресурсу запрещён (403)', async () => {
    const ws = seed.workspaceId;

    // Sanity: до удаления членство валидно и доступ есть.
    const ok = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/accounts`,
      token,
      payload: { name: 'ДоУдаления', type: 'CASH' },
    });
    expect(ok.statusCode).toBe(201);

    // Soft-delete самого workspace (deletedAt), членство НЕ трогаем.
    await H.prisma.workspace.update({
      where: { id: ws },
      data: { deletedAt: new Date() },
    });

    const forbidden = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/accounts`,
      token,
      payload: { name: 'ПослеУдаления', type: 'CASH' },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it('soft-deleted workspace → GET вложенного ресурса тоже запрещён (403)', async () => {
    const ws = seed.workspaceId;

    await H.prisma.workspace.update({
      where: { id: ws },
      data: { deletedAt: new Date() },
    });

    const forbidden = await H.inject({
      method: 'GET',
      url: `/workspaces/${ws}/accounts`,
      token,
    });
    expect(forbidden.statusCode).toBe(403);
  });
});
