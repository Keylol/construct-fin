import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildHarness, resetDb, seedBase, type Harness, type Seed } from '../test/money-harness';
import { CryptoService } from './crypto.service';
import { InboxService } from './inbox.service';

/**
 * Поиск и фильтры во «Входящих». Без них разбор месяца превращался в листание:
 * 262 строки грузятся страницами по 50, и чтобы дойти до нужного платежа,
 * приходилось несколько раз жать «Показать ещё».
 *
 * Главный сценарий — поиск по СУММЕ («вот этот платёж на 66 019»): именно её
 * человек видит в выписке и копирует. Сумма хранится Decimal, поэтому текстовым
 * поиском не находится и разбирается отдельно.
 */
const KEY32 = Buffer.alloc(32, 7).toString('base64');

let h: Harness;
let seed: Seed;
let inbox: InboxService;
let crypto: CryptoService;
let tg = 3900000n;

beforeAll(() => {
  h = buildHarness();
  crypto = new CryptoService({ get: () => KEY32 } as never);
  inbox = new InboxService(
    h.prisma as never,
    h.orders as never,
    h.rules as never,
    h.transfer as never,
    h.planning as never,
  );
});
afterAll(async () => {
  await h.prisma.$disconnect();
});
beforeEach(async () => {
  await resetDb(h.prisma);
  tg += 1n;
  seed = await seedBase(h.prisma, tg);
});

async function connection(accountId: string, keyLast4 = '1111') {
  return h.prisma.integrationConnection.create({
    data: {
      workspaceId: seed.workspaceId,
      provider: 'ALFA',
      accountId,
      credentialEnc: crypto.encrypt('token'),
      keyLast4,
      createdById: seed.userId,
    },
  });
}

async function line(over: {
  connectionId: string;
  externalId: string;
  amount: string;
  direction?: 'INCOME' | 'EXPENSE';
  date?: string;
  description?: string;
  counterpartyName?: string;
  counterpartyInn?: string;
}) {
  return h.prisma.bankStatementLine.create({
    data: {
      workspaceId: seed.workspaceId,
      connectionId: over.connectionId,
      externalId: over.externalId,
      date: new Date(over.date ?? '2026-07-15T10:00:00.000Z'),
      amount: over.amount,
      direction: over.direction ?? 'EXPENSE',
      description: over.description ?? null,
      counterpartyName: over.counterpartyName ?? null,
      counterpartyInn: over.counterpartyInn ?? null,
      status: 'NEW',
    },
  });
}

describe('Входящие: поиск', () => {
  it('находит строку по сумме — так её ищут чаще всего', async () => {
    const c = await connection(seed.accountId);
    const target = await line({ connectionId: c.id, externalId: 'a', amount: '66019.00' });
    await line({ connectionId: c.id, externalId: 'b', amount: '9300.00' });
    await line({ connectionId: c.id, externalId: 'c', amount: '15498.00' });

    const res = await inbox.list(seed.workspaceId, { status: 'NEW', limit: 50, q: '66019' });

    expect(res.items).toHaveLength(1);
    expect(res.items[0]!.id).toBe(target.id);
  });

  it('сумму принимает в том виде, в каком её видно на экране — с пробелами и запятой', async () => {
    const c = await connection(seed.accountId);
    await line({ connectionId: c.id, externalId: 'a', amount: '66019.00' });

    for (const q of ['66 019', '66019,00', '66019.00']) {
      const res = await inbox.list(seed.workspaceId, { status: 'NEW', limit: 50, q });
      expect(res.items, `запрос «${q}»`).toHaveLength(1);
    }
  });

  it('ищет по назначению, контрагенту и ИНН, регистр не важен', async () => {
    const c = await connection(seed.accountId);
    await line({
      connectionId: c.id,
      externalId: 'a',
      amount: '1000.00',
      description: 'Оплата товаров в Wildberries',
    });
    await line({
      connectionId: c.id,
      externalId: 'b',
      amount: '2000.00',
      counterpartyName: 'ООО «НЕОТЕХ»',
      counterpartyInn: '9703076320',
    });
    await line({ connectionId: c.id, externalId: 'c', amount: '3000.00', description: 'прочее' });

    expect((await inbox.list(seed.workspaceId, { status: 'NEW', limit: 50, q: 'wildberries' })).items)
      .toHaveLength(1);
    expect((await inbox.list(seed.workspaceId, { status: 'NEW', limit: 50, q: 'неотех' })).items)
      .toHaveLength(1);
    expect((await inbox.list(seed.workspaceId, { status: 'NEW', limit: 50, q: '9703076320' })).items)
      .toHaveLength(1);
  });

  it('пустой результат, когда ничего не совпало', async () => {
    const c = await connection(seed.accountId);
    await line({ connectionId: c.id, externalId: 'a', amount: '1000.00', description: 'обед' });

    const res = await inbox.list(seed.workspaceId, { status: 'NEW', limit: 50, q: 'такого нет' });
    expect(res.items).toHaveLength(0);
    expect(res.nextCursor).toBeNull();
  });
});

describe('Входящие: фильтры', () => {
  it('фильтр по направлению', async () => {
    const c = await connection(seed.accountId);
    await line({ connectionId: c.id, externalId: 'a', amount: '100.00', direction: 'EXPENSE' });
    await line({ connectionId: c.id, externalId: 'b', amount: '200.00', direction: 'INCOME' });

    const inc = await inbox.list(seed.workspaceId, { status: 'NEW', limit: 50, direction: 'INCOME' });
    expect(inc.items).toHaveLength(1);
    expect(inc.items[0]!.amount).toBe('200');
  });

  it('фильтр по счёту — счёт у строки лежит в подключении', async () => {
    const second = await h.accounts.create(seed.workspaceId, {
      name: 'ВБ Каменск …8975',
      type: 'BANK',
      class: 'OPERATING',
      openingBalance: '0',
    });
    const c1 = await connection(seed.accountId, '1111');
    const c2 = await connection(second.id, '2222');
    await line({ connectionId: c1.id, externalId: 'a', amount: '100.00' });
    await line({ connectionId: c2.id, externalId: 'b', amount: '200.00' });

    const res = await inbox.list(seed.workspaceId, {
      status: 'NEW',
      limit: 50,
      accountId: second.id,
    });
    expect(res.items).toHaveLength(1);
    expect(res.items[0]!.account.id).toBe(second.id);
  });

  it('фильтр по датам — когда разбирают конкретный месяц', async () => {
    const c = await connection(seed.accountId);
    await line({ connectionId: c.id, externalId: 'a', amount: '100.00', date: '2026-06-20T10:00:00.000Z' });
    await line({ connectionId: c.id, externalId: 'b', amount: '200.00', date: '2026-07-15T10:00:00.000Z' });
    await line({ connectionId: c.id, externalId: 'c', amount: '300.00', date: '2026-08-05T10:00:00.000Z' });

    const res = await inbox.list(seed.workspaceId, {
      status: 'NEW',
      limit: 50,
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-07-31T23:59:59.000Z',
    });
    expect(res.items).toHaveLength(1);
    expect(res.items[0]!.amount).toBe('200');
  });

  it('фильтры складываются друг с другом', async () => {
    const c = await connection(seed.accountId);
    await line({ connectionId: c.id, externalId: 'a', amount: '5000.00', direction: 'INCOME', description: 'Оплата ПК' });
    await line({ connectionId: c.id, externalId: 'b', amount: '5000.00', direction: 'EXPENSE', description: 'Оплата ПК' });

    const res = await inbox.list(seed.workspaceId, {
      status: 'NEW',
      limit: 50,
      q: 'оплата',
      direction: 'INCOME',
    });
    expect(res.items).toHaveLength(1);
    expect(res.items[0]!.direction).toBe('INCOME');
  });

  it('счётчик в меню не зависит от фильтров — он про остаток работы', async () => {
    const c = await connection(seed.accountId);
    await line({ connectionId: c.id, externalId: 'a', amount: '100.00' });
    await line({ connectionId: c.id, externalId: 'b', amount: '200.00' });

    const filtered = await inbox.list(seed.workspaceId, { status: 'NEW', limit: 50, q: '100' });
    expect(filtered.items).toHaveLength(1);
    expect(await inbox.count(seed.workspaceId)).toEqual({ count: 2 });
  });
});
