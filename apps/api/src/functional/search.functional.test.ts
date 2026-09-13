/**
 * Общий поиск через HTTP (GET /workspaces/:wsId/search): «Поиск ⌘K» и поле на
 * Главной находят записи во всех разделах одним запросом.
 *
 * Проверяем группы и лимит, роли (оператору не показываем счета, статьи и прочих
 * контрагентов — как в меню), и что служебное (себестоимость, отклонённые строки
 * выписки) и чужая организация в выдачу не попадают.
 *
 * Диапазон telegramId: 2810000n+ (не пересекается с другими сьютами).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { TransactionKind } from '@prisma/client';
import { buildHttpApp, type HttpApp } from '../e2e/http-harness';
import { resetDb, seedBase, seedMember, type Seed } from '../test/money-harness';

let H: HttpApp;
let seed: Seed;
let token: string;
let tg = 2810000n;

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

interface Body {
  query: string;
  groups: Array<{ key: string; total: number; items: Array<{ id: string }> }>;
}

const search = async (query: string, as = token, extra = '') => {
  const res = await H.inject({
    method: 'GET',
    url: `/workspaces/${seed.workspaceId}/search?q=${encodeURIComponent(query)}${extra}`,
    token: as,
  });
  expect(res.statusCode).toBe(200);
  return res.json<Body>();
};

const keys = (body: Body) => body.groups.map((g) => g.key);

function tx(description: string, kind: TransactionKind = 'OTHER') {
  return H.prisma.transaction.create({
    data: {
      workspaceId: seed.workspaceId,
      accountId: seed.accountId,
      createdById: seed.userId,
      type: 'EXPENSE',
      kind,
      amount: '1000.00',
      date: new Date('2026-08-10T07:00:00.000Z'),
      description,
    },
  });
}

describe('Общий поиск', () => {
  it('пустой запрос — 200 и без групп', async () => {
    const body = await search('   ');
    expect(body).toEqual({ query: '', groups: [] });
  });

  it('находит записи разных разделов одним запросом; total — всего, items — по лимиту', async () => {
    const client = await H.prisma.counterparty.create({
      data: { workspaceId: seed.workspaceId, name: 'Семёнов Пётр', role: 'CLIENT' },
    });
    await H.prisma.order.create({
      data: {
        workspaceId: seed.workspaceId,
        number: 'ORD-2026-0001',
        title: 'Сборка ПК',
        clientId: client.id,
        subtotal: '1000.00',
        totalAmount: '1000.00',
      },
    });
    await tx('Оплата от Семёнова, аванс');
    await tx('Оплата от Семёнова, остаток');
    await tx('Оплата от Семёнова, доставка');
    await tx('Канцелярия');

    const body = await search('семенов', token, '&limit=2');

    expect(body.query).toBe('семенов');
    expect(keys(body)).toEqual(['orders', 'clients', 'transactions']);
    const transactions = body.groups.find((g) => g.key === 'transactions')!;
    expect(transactions.total).toBe(3);
    expect(transactions.items).toHaveLength(2);
  });

  it('оператору не показываем счета, статьи и прочих контрагентов — как в меню', async () => {
    await H.prisma.account.create({
      data: { workspaceId: seed.workspaceId, name: 'Касса Семёнова', type: 'CASH' },
    });
    await H.prisma.category.create({
      data: { workspaceId: seed.workspaceId, name: 'Премия Семёнову', kind: 'EXPENSE' },
    });
    await H.prisma.counterparty.create({
      data: { workspaceId: seed.workspaceId, name: 'Банк Семёнова', role: 'OTHER' },
    });
    await H.prisma.counterparty.create({
      data: { workspaceId: seed.workspaceId, name: 'Семёнов Пётр', role: 'CLIENT' },
    });

    const owner = await search('семенов');
    expect(keys(owner)).toEqual(['clients', 'counterparties', 'accounts', 'categories']);

    const operatorTg = tg + 50000n;
    const operator = await H.prisma.user.create({
      data: { telegramId: operatorTg, username: 'operator', firstName: 'Оператор' },
    });
    await seedMember(H.prisma, seed.workspaceId, operator.id, 'MEMBER');
    const operatorToken = await H.jwtFor(operator.id, operatorTg);

    expect(keys(await search('семенов', operatorToken))).toEqual(['clients']);
  });

  it('себестоимость, отклонённые строки выписки и чужая организация в выдачу не попадают', async () => {
    await tx('Себестоимость: Семёнов', 'COGS');
    const connection = await H.prisma.integrationConnection.create({
      data: {
        workspaceId: seed.workspaceId,
        provider: 'FILE',
        accountId: seed.accountId,
        createdById: seed.userId,
      },
    });
    await H.prisma.bankStatementLine.create({
      data: {
        workspaceId: seed.workspaceId,
        connectionId: connection.id,
        externalId: 'dismissed',
        date: new Date('2026-08-10T07:00:00.000Z'),
        amount: '100.00',
        direction: 'INCOME',
        counterpartyName: 'Семёнов',
        status: 'DISMISSED',
      },
    });
    const other = await seedBase(H.prisma, tg + 60000n);
    await H.prisma.counterparty.create({
      data: { workspaceId: other.workspaceId, name: 'Семёнов из чужой организации', role: 'CLIENT' },
    });

    expect((await search('семенов')).groups).toEqual([]);
  });
});
