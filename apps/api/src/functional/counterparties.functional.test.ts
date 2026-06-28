/**
 * Функциональные тесты мутаций контрагентов (Фаза 2.2 — «кнопка → HTTP → БД»).
 *
 * Через РЕАЛЬНЫЙ Nest+Fastify (buildHttpApp): JwtAuthGuard + WorkspaceGuard +
 * ZodPipe + AllExceptionsFilter — полный прод-пайплайн. На каждую мутацию:
 * запрос → проверка HTTP-кода → проверка точных последствий в БД через Prisma.
 *
 * Эндпоинты: POST /counterparties · PATCH /counterparties/:id · DELETE /counterparties/:id.
 * Диапазон telegramId: 2210000n+ (не пересекается с другими сьютами).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildHttpApp, type HttpApp } from '../e2e/http-harness';
import { resetDb, seedBase, seedMember, type Seed } from '../test/money-harness';

let H: HttpApp;
let seed: Seed;
let token: string;
let tg = 2210000n;

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

describe('Функциональные мутации: контрагенты (counterparties)', () => {
  it('POST /counterparties → 201 и создаёт Counterparty в БД с переданными полями', async () => {
    const ws = seed.workspaceId;
    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/counterparties`,
      token,
      payload: {
        name: 'ООО Поставщик',
        role: 'SUPPLIER',
        contact: '+7 900 000-00-00',
        note: 'осн.',
        inn: '7701234567',
        payRate: '1500.50',
      },
    });
    expect(res.statusCode).toBe(201);
    const created = res.json<{ id: string }>();
    expect(created.id).toBeTruthy();

    const row = await H.prisma.counterparty.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.workspaceId).toBe(ws);
    expect(row.name).toBe('ООО Поставщик');
    expect(row.role).toBe('SUPPLIER');
    expect(row.contact).toBe('+7 900 000-00-00');
    expect(row.note).toBe('осн.');
    expect(row.inn).toBe('7701234567');
    expect(row.payRate?.toString()).toBe('1500.5');
    expect(row.isArchived).toBe(false);
    expect(row.deletedAt).toBeNull();
  });

  it('POST /counterparties → дефолт role=OTHER и nullable-поля null', async () => {
    const ws = seed.workspaceId;
    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/counterparties`,
      token,
      payload: { name: 'Без роли' },
    });
    expect(res.statusCode).toBe(201);
    const row = await H.prisma.counterparty.findUniqueOrThrow({ where: { id: res.json<{ id: string }>().id } });
    expect(row.role).toBe('OTHER');
    expect(row.contact).toBeNull();
    expect(row.payRate).toBeNull();
  });

  it('POST /counterparties → 400 на невалидном role (ZodPipe), запись не создаётся', async () => {
    const ws = seed.workspaceId;
    const before = await H.prisma.counterparty.count({ where: { workspaceId: ws } });
    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/counterparties`,
      token,
      payload: { name: 'X', role: 'PARTNER' },
    });
    expect(res.statusCode).toBe(400);
    const after = await H.prisma.counterparty.count({ where: { workspaceId: ws } });
    expect(after).toBe(before);
  });

  it('POST /counterparties → 400 на невалидном payRate (ZodPipe), запись не создаётся', async () => {
    const ws = seed.workspaceId;
    const before = await H.prisma.counterparty.count({ where: { workspaceId: ws } });
    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/counterparties`,
      token,
      payload: { name: 'X', payRate: '12.345' },
    });
    expect(res.statusCode).toBe(400);
    const after = await H.prisma.counterparty.count({ where: { workspaceId: ws } });
    expect(after).toBe(before);
  });

  it('PATCH /counterparties/:id → 200 и обновляет поля в БД', async () => {
    const ws = seed.workspaceId;
    const cp = await H.prisma.counterparty.create({
      data: { workspaceId: ws, name: 'Старое', role: 'CLIENT' },
    });
    const res = await H.inject({
      method: 'PATCH',
      url: `/workspaces/${ws}/counterparties/${cp.id}`,
      token,
      payload: { name: 'Новое', role: 'EMPLOYEE', position: 'Прораб', payRate: '90000.00', isArchived: true },
    });
    expect(res.statusCode).toBe(200);
    const row = await H.prisma.counterparty.findUniqueOrThrow({ where: { id: cp.id } });
    expect(row.name).toBe('Новое');
    expect(row.role).toBe('EMPLOYEE');
    expect(row.position).toBe('Прораб');
    expect(row.payRate?.toString()).toBe('90000');
    expect(row.isArchived).toBe(true);
  });

  it('DELETE /counterparties/:id → 204 и помечает запись soft-deleted (deletedAt)', async () => {
    const ws = seed.workspaceId;
    const cp = await H.prisma.counterparty.create({
      data: { workspaceId: ws, name: 'НаУдаление', role: 'OTHER' },
    });
    const res = await H.inject({
      method: 'DELETE',
      url: `/workspaces/${ws}/counterparties/${cp.id}`,
      token,
    });
    expect(res.statusCode).toBe(204);
    const row = await H.prisma.counterparty.findUniqueOrThrow({ where: { id: cp.id } });
    expect(row.deletedAt).not.toBeNull();
  });

  it('негатив: 401 без токена и 403 к чужому workspace', async () => {
    const ws = seed.workspaceId;
    const noAuth = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/counterparties`,
      payload: { name: 'Y' },
    });
    expect(noAuth.statusCode).toBe(401);

    const otherWs = await H.prisma.workspace.create({
      data: { name: 'Чужой', owner: { create: { telegramId: tg + 500000n, username: 'other', firstName: 'O' } } },
    });
    const forbidden = await H.inject({
      method: 'POST',
      url: `/workspaces/${otherWs.id}/counterparties`,
      token,
      payload: { name: 'Z' },
    });
    expect(forbidden.statusCode).toBe(403);
  });
});
