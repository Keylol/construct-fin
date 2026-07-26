/**
 * E2E (DB-backed) изоляция банковских интеграций между пространствами (Ф2/Ф3).
 *
 * Сценарий из жизни: два ИП (разные пространства) со своими банками, своими
 * токенами и своими сертификатами. Операции одного не должны ни при каких
 * условиях оказаться в учёте другого — ни через синк, ни через Inbox, ни через
 * правила автокатегоризации.
 *
 * Сервисы вызываются на уровне домена (мимо WorkspaceGuard) — именно здесь
 * живут проверки принадлежности.
 *
 * Уникальный диапазон telegramId этого файла: 2100000n+.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildHarness, resetDb, seedBase, type Harness, type Seed } from '../test/money-harness';
import { CryptoService } from './crypto.service';
import { AdapterRegistry } from './adapter-registry';
import { FakeBankAdapter } from './adapters/fake-bank.adapter';
import { SyncService } from './sync.service';
import { IntegrationsService } from './integrations.service';
import { InboxService } from './inbox.service';
import type { BankProviderAdapter, FetchStatementInput } from './provider-adapter';

const KEY32 = Buffer.alloc(32, 11).toString('base64');

let h: Harness;
let A: Seed; // ИП №1
let B: Seed; // ИП №2
let crypto: CryptoService;
let tg = 2100000n;

/** Адаптер, который запоминает, с какими секретами его звали, и отдаёт свои строки. */
function spyAdapter(tag: string) {
  const calls: FetchStatementInput[] = [];
  const adapter: BankProviderAdapter = {
    provider: 'ALFA',
    fetchStatement: (input) => {
      calls.push(input);
      return Promise.resolve({
        lines: [
          {
            externalId: `${tag}-1`,
            date: new Date('2026-07-20T10:00:00Z'),
            amount: '1000.00',
            direction: 'INCOME' as const,
            counterpartyName: `Контрагент ${tag}`,
            description: `аренда ${tag}`,
          },
        ],
        nextCursor: 'done',
      });
    },
  };
  return { adapter, calls };
}

function buildSync(adapter?: BankProviderAdapter) {
  const registry = new AdapterRegistry(new FakeBankAdapter(), { get: () => 'test' } as never);
  if (adapter) registry.register('ALFA', adapter);
  return new SyncService(h.prisma as never, crypto, registry);
}

async function makeConnection(seed: Seed, secret: string, tls?: string) {
  return h.prisma.integrationConnection.create({
    data: {
      workspaceId: seed.workspaceId,
      provider: 'ALFA',
      accountId: seed.accountId,
      credentialEnc: crypto.encrypt(secret),
      keyLast4: secret.slice(-4),
      externalAccountId: '40802810401300015422',
      ...(tls ? { tlsCredentialEnc: crypto.encrypt(tls) } : {}),
      createdById: seed.userId,
    },
  });
}

beforeAll(() => {
  h = buildHarness();
  crypto = new CryptoService({ get: () => KEY32 } as never);
});
afterAll(async () => {
  await h.prisma.$disconnect();
});
beforeEach(async () => {
  await resetDb(h.prisma);
  tg += 1n;
  A = await seedBase(h.prisma, tg);
  tg += 1n;
  B = await seedBase(h.prisma, tg);
});

describe('подключения: чужое пространство не видит и не трогает', () => {
  it('list отдаёт только свои подключения', async () => {
    await makeConnection(A, 'secret-aaaa');
    await makeConnection(B, 'secret-bbbb');
    const svc = new IntegrationsService(h.prisma as never, crypto, buildSync(), h.audit as never);

    const listA = await svc.list(A.workspaceId);
    expect(listA).toHaveLength(1);
    expect(listA[0]!.keyLast4).toBe('aaaa');
  });

  it('чужое подключение нельзя обновить, удалить или синкнуть', async () => {
    const connB = await makeConnection(B, 'secret-bbbb');
    const svc = new IntegrationsService(h.prisma as never, crypto, buildSync(), h.audit as never);

    // Владелец A подставляет id подключения B — все три пути дают 404.
    await expect(
      svc.update(A.workspaceId, connB.id, A.userId, { status: 'DISABLED' }),
    ).rejects.toThrow(/не найдено/);
    await expect(svc.softDelete(A.workspaceId, connB.id, A.userId)).rejects.toThrow(/не найдено/);
    await expect(svc.syncNow(A.workspaceId, connB.id)).rejects.toThrow(/не найдено/);

    // Подключение B осталось нетронутым.
    const after = await h.prisma.integrationConnection.findUniqueOrThrow({ where: { id: connB.id } });
    expect(after.status).toBe('ACTIVE');
    expect(after.deletedAt).toBeNull();
  });

  it('подключение нельзя завести на чужой счёт', async () => {
    const svc = new IntegrationsService(h.prisma as never, crypto, buildSync(), h.audit as never);
    await expect(
      svc.create(A.workspaceId, A.userId, {
        provider: 'ALFA',
        accountId: B.accountId, // чужой счёт
        token: 'tok-1234',
        accountNumber: '40802810401300015422',
      }),
    ).rejects.toThrow(/Счёт не найден/);
    expect(await h.prisma.integrationConnection.count()).toBe(0);
  });
});

describe('синк: строки и проводки не покидают своё пространство', () => {
  it('строки, проводки и счёт достаются только своему пространству', async () => {
    const connA = await makeConnection(A, 'secret-aaaa');
    const connB = await makeConnection(B, 'secret-bbbb');
    const { adapter } = spyAdapter('X');
    const sync = buildSync(adapter);

    await sync.syncConnection(connA.id);
    await sync.syncConnection(connB.id);

    const linesA = await h.prisma.bankStatementLine.findMany({
      where: { workspaceId: A.workspaceId },
    });
    const linesB = await h.prisma.bankStatementLine.findMany({
      where: { workspaceId: B.workspaceId },
    });
    expect(linesA).toHaveLength(1);
    expect(linesB).toHaveLength(1);
    // Строка каждого пространства висит на СВОЁМ подключении и своём счёте.
    expect(linesA[0]!.connectionId).toBe(connA.id);
    expect(linesB[0]!.connectionId).toBe(connB.id);
  });

  it('каждое подключение уходит в банк со СВОИМ токеном и своим сертификатом', async () => {
    const connA = await makeConnection(A, 'token-A-aaaa', '{"cert":"CERT-A","key":"KEY-A"}');
    const connB = await makeConnection(B, 'token-B-bbbb', '{"cert":"CERT-B","key":"KEY-B"}');
    const { adapter, calls } = spyAdapter('X');
    const sync = buildSync(adapter);

    await sync.syncConnection(connA.id);
    await sync.syncConnection(connB.id);

    expect(calls[0]!.token).toBe('token-A-aaaa');
    expect(calls[0]!.tls).toEqual({ cert: 'CERT-A', key: 'KEY-A' });
    expect(calls[1]!.token).toBe('token-B-bbbb');
    expect(calls[1]!.tls).toEqual({ cert: 'CERT-B', key: 'KEY-B' });
  });

  it('правило чужого пространства НЕ категоризует наши строки', async () => {
    // У B есть правило «аренда → категория B». У A правил нет.
    const catB = await h.categories.create(B.workspaceId, { name: 'Аренда B', kind: 'EXPENSE', isFixedCost: false });
    await h.prisma.rule.create({
      data: {
        workspaceId: B.workspaceId,
        name: 'Аренда B',
        appliesTo: 'BOTH',
        conditions: [{ type: 'DESCRIPTION_CONTAINS', value: 'аренда' }],
        actions: [{ type: 'SET_CATEGORY', categoryId: catB.id }],
      },
    });

    const connA = await makeConnection(A, 'secret-aaaa');
    const { adapter } = spyAdapter('X'); // описание строки содержит «аренда»
    const res = await buildSync(adapter).syncConnection(connA.id);

    // Правило соседа не сработало: строка ушла в Inbox без категории.
    expect(res.autoPosted).toBe(0);
    const line = await h.prisma.bankStatementLine.findFirstOrThrow({
      where: { workspaceId: A.workspaceId },
    });
    expect(line.status).toBe('NEW');
    expect(line.suggestedCategoryId).toBeNull();
    // И ни одной проводки в чужом пространстве не появилось.
    expect(await h.prisma.transaction.count({ where: { workspaceId: B.workspaceId } })).toBe(0);
  });

  it('плановый крон синкает оба пространства, не смешивая их', async () => {
    await makeConnection(A, 'secret-aaaa');
    await makeConnection(B, 'secret-bbbb');
    const { adapter } = spyAdapter('X');

    await buildSync(adapter).syncAllActive();

    const linesA = await h.prisma.bankStatementLine.count({ where: { workspaceId: A.workspaceId } });
    const linesB = await h.prisma.bankStatementLine.count({ where: { workspaceId: B.workspaceId } });
    expect(linesA).toBe(1);
    expect(linesB).toBe(1);
  });
});

describe('Inbox: разбор чужих строк невозможен', () => {
  async function seedLine(seed: Seed) {
    const conn = await makeConnection(seed, `secret-${seed.workspaceId.slice(-4)}`);
    return h.prisma.bankStatementLine.create({
      data: {
        workspaceId: seed.workspaceId,
        connectionId: conn.id,
        externalId: `ext-${seed.workspaceId.slice(-6)}`,
        date: new Date('2026-07-20T10:00:00Z'),
        amount: '1000.00',
        direction: 'INCOME',
        status: 'NEW',
      },
    });
  }

  it('list и count видят только свои строки', async () => {
    await seedLine(A);
    await seedLine(B);
    const inbox = new InboxService(h.prisma as never, h.orders as never);

    const list = await inbox.list(A.workspaceId, { limit: 50 });
    expect(list.items).toHaveLength(1);
    expect(await inbox.count(A.workspaceId)).toEqual({ count: 1 });
  });

  it('categorize/dismiss/undo чужой строки → 404, строка не меняется', async () => {
    const lineB = await seedLine(B);
    const catA = await h.categories.create(A.workspaceId, { name: 'Услуги A', kind: 'INCOME', isFixedCost: false });
    const inbox = new InboxService(h.prisma as never, h.orders as never);

    await expect(
      inbox.categorize(A.workspaceId, A.userId, lineB.id, { categoryId: catA.id }),
    ).rejects.toThrow(/не найдена/);
    await expect(inbox.dismiss(A.workspaceId, lineB.id)).rejects.toThrow(/не найдена/);
    await expect(inbox.undo(A.workspaceId, lineB.id)).rejects.toThrow(/не найдена/);

    const after = await h.prisma.bankStatementLine.findUniqueOrThrow({ where: { id: lineB.id } });
    expect(after.status).toBe('NEW');
    expect(await h.prisma.transaction.count()).toBe(0);
  });

  it('свою строку нельзя провести по чужой категории', async () => {
    const lineA = await seedLine(A);
    const catB = await h.categories.create(B.workspaceId, { name: 'Услуги B', kind: 'INCOME', isFixedCost: false });
    const inbox = new InboxService(h.prisma as never, h.orders as never);

    await expect(
      inbox.categorize(A.workspaceId, A.userId, lineA.id, { categoryId: catB.id }),
    ).rejects.toThrow(/Категория не найдена/);
    expect(await h.prisma.transaction.count()).toBe(0);
  });

  it('свою строку нельзя привязать к чужому заказу — строка возвращается в Inbox', async () => {
    const lineA = await seedLine(A);
    const clientB = await h.prisma.counterparty.create({
      data: { workspaceId: B.workspaceId, name: 'Клиент B', role: 'CLIENT' },
    });
    const orderB = await h.orders.create(B.workspaceId, {
      clientId: clientB.id,
      items: [{ name: 'Товар B', qty: '1', unitPrice: '1000' }],
    });
    const inbox = new InboxService(h.prisma as never, h.orders as never);

    await expect(inbox.attachOrder(A.workspaceId, A.userId, lineA.id, orderB.id)).rejects.toThrow();

    // Строка вернулась в NEW, оплата в чужом заказе не появилась.
    const after = await h.prisma.bankStatementLine.findUniqueOrThrow({ where: { id: lineA.id } });
    expect(after.status).toBe('NEW');
    expect(
      await h.prisma.transaction.count({ where: { workspaceId: B.workspaceId } }),
    ).toBe(0);
  });
});
