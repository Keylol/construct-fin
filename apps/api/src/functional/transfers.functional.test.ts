/**
 * Функциональные тесты мутаций переводов (Фаза 2.2 — «кнопка → HTTP → БД»).
 *
 * Через РЕАЛЬНЫЙ Nest+Fastify (buildHttpApp): JwtAuthGuard + WorkspaceGuard +
 * ZodPipe + AllExceptionsFilter — полный прод-пайплайн. На каждую мутацию:
 * запрос → проверка HTTP-кода → проверка точных последствий в БД через Prisma.
 *
 * Перевод создаётся атомарно: одна Transfer + ДВЕ ноги-Transaction (TRANSFER_OUT
 * EXPENSE со счёта-источника, TRANSFER_IN INCOME на счёт-получатель, обе на amount),
 * общий transferGroupId = Transfer.id. При fee>0 — третья Transaction(VARIABLE_COST)
 * на счёте-источнике. softDelete гасит перевод и все его ноги каскадом по
 * transferGroupId. Деньги — Decimal-строки, сверяем через .toFixed(2).
 * Диапазон telegramId: 2310000n+ (не пересекается с другими сьютами).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildHttpApp, type HttpApp } from '../e2e/http-harness';
import { resetDb, seedBase, seedMember, type Seed } from '../test/money-harness';

let H: HttpApp;
let seed: Seed;
let token: string;
let toAccountId: string; // второй счёт-получатель (seedBase даёт только один)
let tg = 2310000n;

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
  // Второй счёт для перевода: seedBase создаёт только seed.accountId.
  const to = await H.prisma.account.create({
    data: { workspaceId: seed.workspaceId, name: 'Банк', type: 'BANK', openingBalance: '0' },
  });
  toAccountId = to.id;
});

describe('Функциональные мутации: переводы (transfers)', () => {
  it('POST /transfers → 201, создаёт Transfer + ОБЕ ноги (OUT/IN) + комиссию в БД', async () => {
    const ws = seed.workspaceId;
    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/transfers`,
      token,
      payload: {
        fromAccountId: seed.accountId,
        toAccountId,
        amount: '1000.00',
        fee: '25.50',
        date: '2026-06-01T00:00:00.000Z',
        note: 'на банк',
      },
    });
    expect(res.statusCode).toBe(201);
    const created = res.json<{ id: string; amount: string; fee: string }>();
    expect(created.id).toBeTruthy();
    expect(created.amount).toBe('1000.00');
    expect(created.fee).toBe('25.50');

    // Сама запись Transfer.
    const transfer = await H.prisma.transfer.findUniqueOrThrow({ where: { id: created.id } });
    expect(transfer.workspaceId).toBe(ws);
    expect(transfer.fromAccountId).toBe(seed.accountId);
    expect(transfer.toAccountId).toBe(toAccountId);
    expect(transfer.amount.toFixed(2)).toBe('1000.00');
    expect(transfer.fee.toFixed(2)).toBe('25.50');
    expect(transfer.note).toBe('на банк');
    expect(transfer.createdById).toBe(seed.userId);
    expect(transfer.deletedAt).toBeNull();

    // Все транзакции, связанные с переводом (2 ноги + комиссия = 3).
    const legs = await H.prisma.transaction.findMany({
      where: { transferGroupId: created.id },
    });
    expect(legs).toHaveLength(3);

    // Нога OUT: списание со счёта-источника.
    const out = legs.find((l) => l.kind === 'TRANSFER_OUT');
    expect(out).toBeDefined();
    expect(out!.type).toBe('EXPENSE');
    expect(out!.accountId).toBe(seed.accountId);
    expect(out!.amount.toFixed(2)).toBe('1000.00');

    // Нога IN: приход на счёт-получатель.
    const inLeg = legs.find((l) => l.kind === 'TRANSFER_IN');
    expect(inLeg).toBeDefined();
    expect(inLeg!.type).toBe('INCOME');
    expect(inLeg!.accountId).toBe(toAccountId);
    expect(inLeg!.amount.toFixed(2)).toBe('1000.00');

    // Комиссия: реальный расход VARIABLE_COST на счёте-источнике.
    const feeLeg = legs.find((l) => l.kind === 'VARIABLE_COST');
    expect(feeLeg).toBeDefined();
    expect(feeLeg!.type).toBe('EXPENSE');
    expect(feeLeg!.accountId).toBe(seed.accountId);
    expect(feeLeg!.amount.toFixed(2)).toBe('25.50');
  });

  it('POST /transfers → без fee создаёт ровно ДВЕ ноги (без VARIABLE_COST)', async () => {
    const ws = seed.workspaceId;
    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/transfers`,
      token,
      payload: {
        fromAccountId: seed.accountId,
        toAccountId,
        amount: '300.00',
        date: '2026-06-02T00:00:00.000Z',
      },
    });
    expect(res.statusCode).toBe(201);
    const created = res.json<{ id: string; fee: string }>();
    expect(created.fee).toBe('0.00'); // дефолт fee='0'

    const transfer = await H.prisma.transfer.findUniqueOrThrow({ where: { id: created.id } });
    expect(transfer.fee.toFixed(2)).toBe('0.00');

    const legs = await H.prisma.transaction.findMany({ where: { transferGroupId: created.id } });
    expect(legs).toHaveLength(2);
    expect(legs.some((l) => l.kind === 'VARIABLE_COST')).toBe(false);
    expect(legs.some((l) => l.kind === 'TRANSFER_OUT')).toBe(true);
    expect(legs.some((l) => l.kind === 'TRANSFER_IN')).toBe(true);
  });

  it('POST /transfers → 400 на невалидном payload (amount не строка), записи не создаются', async () => {
    const ws = seed.workspaceId;
    const beforeTransfers = await H.prisma.transfer.count({ where: { workspaceId: ws } });
    const beforeTx = await H.prisma.transaction.count({ where: { workspaceId: ws } });
    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/transfers`,
      token,
      // amount должен быть Decimal-строкой; number отвергается ZodPipe
      payload: {
        fromAccountId: seed.accountId,
        toAccountId,
        amount: 1000,
        date: '2026-06-03T00:00:00.000Z',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(await H.prisma.transfer.count({ where: { workspaceId: ws } })).toBe(beforeTransfers);
    expect(await H.prisma.transaction.count({ where: { workspaceId: ws } })).toBe(beforeTx);
  });

  it('DELETE /transfers/:id → 204 и soft-deletes перевод + ОБЕ ноги + комиссию', async () => {
    const ws = seed.workspaceId;
    // Создаём перевод через HTTP (с комиссией → 3 связанные транзакции).
    const createRes = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/transfers`,
      token,
      payload: {
        fromAccountId: seed.accountId,
        toAccountId,
        amount: '500.00',
        fee: '10.00',
        date: '2026-06-04T00:00:00.000Z',
      },
    });
    expect(createRes.statusCode).toBe(201);
    const transferId = createRes.json<{ id: string }>().id;

    const res = await H.inject({
      method: 'DELETE',
      url: `/workspaces/${ws}/transfers/${transferId}`,
      token,
    });
    expect(res.statusCode).toBe(204);

    // Сам перевод soft-deleted.
    const transfer = await H.prisma.transfer.findUniqueOrThrow({ where: { id: transferId } });
    expect(transfer.deletedAt).not.toBeNull();

    // Все ноги (включая комиссию) soft-deleted каскадом по transferGroupId.
    const legs = await H.prisma.transaction.findMany({ where: { transferGroupId: transferId } });
    expect(legs).toHaveLength(3);
    for (const leg of legs) {
      expect(leg.deletedAt).not.toBeNull();
    }
  });

  it('негатив: 401 без токена и 403 к чужому workspace', async () => {
    const ws = seed.workspaceId;
    const noAuth = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/transfers`,
      payload: { fromAccountId: seed.accountId, toAccountId, amount: '1.00', date: '2026-06-05T00:00:00.000Z' },
    });
    expect(noAuth.statusCode).toBe(401);

    const otherWs = await H.prisma.workspace.create({
      data: { name: 'Чужой', owner: { create: { telegramId: tg + 500000n, username: 'other', firstName: 'O' } } },
    });
    const forbidden = await H.inject({
      method: 'POST',
      url: `/workspaces/${otherWs.id}/transfers`,
      token,
      payload: { fromAccountId: seed.accountId, toAccountId, amount: '1.00', date: '2026-06-05T00:00:00.000Z' },
    });
    expect(forbidden.statusCode).toBe(403);
  });
});
