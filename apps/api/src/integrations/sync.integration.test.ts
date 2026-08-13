import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildHarness, resetDb, seedBase, type Harness, type Seed } from '../test/money-harness';
import { CryptoService } from './crypto.service';
import { AdapterRegistry } from './adapter-registry';
import { FakeBankAdapter } from './adapters/fake-bank.adapter';
import { AlfaAdapter, dayKey } from './adapters/alfa.adapter';
import type { AlfaHttp } from './adapters/alfa-transport';
import { SyncService } from './sync.service';
import { IntegrationsService } from './integrations.service';
import { InboxService } from './inbox.service';

/**
 * Интеграционные тесты синка выписки (Ф1-B) против реальной БД.
 * Провайдер — FakeBankAdapter (4 детерминированные строки). Проверяем:
 * загрузку строк, идемпотентность повторного синка, авто-проводку по правилу,
 * продвижение курсора, обработку ошибки провайдера (status=ERROR).
 */
const KEY32 = Buffer.alloc(32, 3).toString('base64');
const num = (v: { toString(): string }) => Number(v.toString());

let h: Harness;
let seed: Seed;
let sync: SyncService;
let crypto: CryptoService;
let tg = 1900000n;

function buildSync(registry: AdapterRegistry) {
  // h.prisma типизирован как PrismaClient; сервисы харнесса конструируются от
  // того же инстанса (он же PrismaService) — каст как в остальных e2e-тестах.
  return new SyncService(h.prisma as never, crypto, registry);
}

function fakeRegistry() {
  return new AdapterRegistry(new FakeBankAdapter(), { get: () => 'test' } as never);
}

beforeAll(() => {
  h = buildHarness();
  crypto = new CryptoService({ get: () => KEY32 } as never);
  sync = buildSync(fakeRegistry());
});
afterAll(async () => {
  await h.prisma.$disconnect();
});
beforeEach(async () => {
  await resetDb(h.prisma);
  tg += 1n;
  seed = await seedBase(h.prisma, tg);
});

async function makeConnection() {
  return h.prisma.integrationConnection.create({
    data: {
      workspaceId: seed.workspaceId,
      provider: 'ALFA',
      accountId: seed.accountId,
      credentialEnc: crypto.encrypt('secret-token-1234'),
      keyLast4: '1234',
      createdById: seed.userId,
    },
  });
}

describe('SyncService.syncConnection', () => {
  it('загружает строки FakeBank, все в NEW (без правил), курсор продвинут', async () => {
    const conn = await makeConnection();
    const res = await sync.syncConnection(conn.id);

    expect(res.fetched).toBe(4);
    expect(res.created).toBe(4);
    expect(res.autoPosted).toBe(0);

    const lines = await h.prisma.bankStatementLine.findMany({
      where: { connectionId: conn.id },
      orderBy: { date: 'asc' },
    });
    expect(lines).toHaveLength(4);
    expect(lines.every((l) => l.status === 'NEW')).toBe(true);
    expect(lines.every((l) => l.transactionId === null)).toBe(true);
    // Поля нормализованы: знак в direction, сумма положительная, ausnMark сохранён.
    expect(lines[0]!.direction).toBe('INCOME');
    expect(num(lines[0]!.amount)).toBe(15000);
    expect(lines[0]!.ausnMark).toBe('INCOME');
    expect(lines[1]!.ausnMark).toBe('NOT_COUNTED');

    const after = await h.prisma.integrationConnection.findUniqueOrThrow({ where: { id: conn.id } });
    expect(after.syncCursor).toBe('done');
    expect(after.lastSyncAt).not.toBeNull();
    expect(after.status).toBe('ACTIVE');
  });

  it('идемпотентность: повторный синк не дублирует строки', async () => {
    const conn = await makeConnection();
    await sync.syncConnection(conn.id);
    // Сбросим курсор, чтобы FakeBank снова отдал те же 4 строки.
    await h.prisma.integrationConnection.update({
      where: { id: conn.id },
      data: { syncCursor: null },
    });
    const second = await sync.syncConnection(conn.id);

    expect(second.fetched).toBe(4);
    expect(second.created).toBe(0); // все уже загружены
    const count = await h.prisma.bankStatementLine.count({ where: { connectionId: conn.id } });
    expect(count).toBe(4);
  });

  it('авто-проводка: строка, распознанная правилом, → AUTO_POSTED + Transaction', async () => {
    const cat = await h.categories.create(seed.workspaceId, {
      name: 'Аренда',
      kind: 'EXPENSE',
      isFixedCost: true,
      bucket: 'FIXED',
    });
    // Правило: описание содержит «аренда» → категория Аренда.
    await h.prisma.rule.create({
      data: {
        workspaceId: seed.workspaceId,
        name: 'Аренда → FIXED',
        appliesTo: 'BOTH',
        conditions: [{ type: 'DESCRIPTION_CONTAINS', value: 'аренда' }],
        actions: [{ type: 'SET_CATEGORY', categoryId: cat.id }],
      },
    });

    const conn = await makeConnection();
    const res = await sync.syncConnection(conn.id);
    expect(res.autoPosted).toBe(1); // fake-3 «Аренда офиса»

    const posted = await h.prisma.bankStatementLine.findFirstOrThrow({
      where: { connectionId: conn.id, status: 'AUTO_POSTED' },
    });
    expect(posted.externalId).toBe('fake-3');
    expect(posted.transactionId).not.toBeNull();

    const tx = await h.prisma.transaction.findUniqueOrThrow({
      where: { id: posted.transactionId! },
    });
    expect(tx.type).toBe('EXPENSE');
    expect(num(tx.amount)).toBe(8000);
    expect(tx.categoryId).toBe(cat.id);
    expect(tx.accountId).toBe(seed.accountId);
    expect(tx.kind).toBe('OTHER');
    // Остальные 3 строки — в Inbox.
    const inbox = await h.prisma.bankStatementLine.count({
      where: { connectionId: conn.id, status: 'NEW' },
    });
    expect(inbox).toBe(3);
  });

  it('параллельный синк одного подключения не дублирует и не роняет в ERROR (гонка P2002)', async () => {
    const conn = await makeConnection();
    // Два одновременных синка (ручной клик + cron) — второй ловит P2002 построчно.
    const [a, b] = await Promise.all([sync.syncConnection(conn.id), sync.syncConnection(conn.id)]);

    const count = await h.prisma.bankStatementLine.count({ where: { connectionId: conn.id } });
    expect(count).toBe(4); // ровно 4, без дублей
    expect(a.created + b.created).toBe(4); // суммарно создано 4 (как поделились — неважно)
    const after = await h.prisma.integrationConnection.findUniqueOrThrow({ where: { id: conn.id } });
    expect(after.status).toBe('ACTIVE'); // гонка не считается ошибкой подключения
  });

  it('DISABLED-подключение синк пропускает (нулевой результат)', async () => {
    const conn = await makeConnection();
    await h.prisma.integrationConnection.update({
      where: { id: conn.id },
      data: { status: 'DISABLED' },
    });
    const res = await sync.syncConnection(conn.id);
    expect(res).toEqual({ fetched: 0, created: 0, autoPosted: 0, adopted: 0 });
    expect(await h.prisma.bankStatementLine.count({ where: { connectionId: conn.id } })).toBe(0);
  });

  it('ошибка провайдера → статус ERROR + lastSyncError, проброс наверх', async () => {
    const conn = await makeConnection();
    // Реестр, чей адаптер бросает.
    const throwing = new AdapterRegistry(new FakeBankAdapter(), { get: () => 'test' } as never);
    throwing.register('ALFA', {
      provider: 'ALFA',
      fetchStatement: () => Promise.reject(new Error('boom from bank')),
    });
    const brokenSync = buildSync(throwing);

    await expect(brokenSync.syncConnection(conn.id)).rejects.toThrow('boom from bank');
    const after = await h.prisma.integrationConnection.findUniqueOrThrow({ where: { id: conn.id } });
    expect(after.status).toBe('ERROR');
    expect(after.lastSyncError).toContain('boom from bank');
  });
});

describe('IntegrationsService.resetStatement — перезагрузка выписки', () => {
  function svc() {
    return new IntegrationsService(h.prisma as never, crypto, sync, h.audit as never);
  }

  it('сносит строки и снятые с них проводки, обнуляет курсор', async () => {
    const conn = await makeConnection();
    await sync.syncConnection(conn.id); // 4 строки FakeBank
    // Разберём одну строку в обычную проводку.
    const line = await h.prisma.bankStatementLine.findFirstOrThrow({
      where: { connectionId: conn.id },
    });
    const cat = await h.categories.create(seed.workspaceId, {
      name: 'Прочее',
      kind: 'EXPENSE',
      isFixedCost: false,
    });
    const inbox = new InboxService(h.prisma as never, h.orders as never, h.rules as never, h.transfer as never, h.planning as never);
    await inbox.categorize(seed.workspaceId, seed.userId, line.id, { categoryId: cat.id });

    const res = await svc().resetStatement(seed.workspaceId, conn.id, seed.userId);

    expect(res).toEqual({ linesDeleted: 4, transactionsRemoved: 1, orderPaymentsKept: 0 });
    expect(await h.prisma.bankStatementLine.count({ where: { connectionId: conn.id } })).toBe(0);
    // Проводка снята мягко — правило проекта, физически строка остаётся.
    const tx = await h.prisma.transaction.findFirstOrThrow({
      where: { workspaceId: seed.workspaceId, categoryId: cat.id },
    });
    expect(tx.deletedAt).not.toBeNull();

    const after = await h.prisma.integrationConnection.findUniqueOrThrow({ where: { id: conn.id } });
    expect(after.syncCursor).toBeNull();
    expect(after.status).toBe('ACTIVE');
  });

  it('после сброса повторный синк тянет выписку заново', async () => {
    const conn = await makeConnection();
    await sync.syncConnection(conn.id);
    await svc().resetStatement(seed.workspaceId, conn.id, seed.userId);

    const second = await sync.syncConnection(conn.id);
    expect(second.created).toBe(4); // всё пришло снова
    expect(await h.prisma.bankStatementLine.count({ where: { connectionId: conn.id } })).toBe(4);
  });

  it('ОПЛАТЫ ЗАКАЗОВ и их строки уцелевают — иначе повторный синк создал бы вторую оплату', async () => {
    const conn = await makeConnection();
    await sync.syncConnection(conn.id);
    const income = await h.prisma.bankStatementLine.findFirstOrThrow({
      where: { connectionId: conn.id, direction: 'INCOME' },
    });
    const client = await h.prisma.counterparty.create({
      data: { workspaceId: seed.workspaceId, name: 'Клиент', role: 'CLIENT' },
    });
    const order = await h.orders.create(seed.workspaceId, {
      clientId: client.id,
      items: [{ name: 'Товар', qty: '1', unitPrice: '15000' }],
    });
    const inbox = new InboxService(h.prisma as never, h.orders as never, h.rules as never, h.transfer as never, h.planning as never);
    await inbox.attachOrder(seed.workspaceId, seed.userId, income.id, { orderId: order.id });

    const res = await svc().resetStatement(seed.workspaceId, conn.id, seed.userId);

    expect(res.orderPaymentsKept).toBe(1);
    expect(res.linesDeleted).toBe(3);
    // Строка оплаты осталась — она же защищает от повторного втягивания.
    const left = await h.prisma.bankStatementLine.findMany({ where: { connectionId: conn.id } });
    expect(left).toHaveLength(1);
    expect(left[0]!.id).toBe(income.id);
    // Оплата заказа на месте, заказ не пострадал.
    const payment = await h.prisma.transaction.findFirstOrThrow({
      where: { orderId: order.id, kind: 'ORDER_PAYMENT' },
    });
    expect(payment.deletedAt).toBeNull();
  });

  it('операции, заведённые руками, сброс не трогает', async () => {
    const conn = await makeConnection();
    await sync.syncConnection(conn.id);
    const manual = await h.prisma.transaction.create({
      data: {
        workspaceId: seed.workspaceId,
        accountId: seed.accountId,
        date: new Date('2026-07-01T00:00:00Z'),
        amount: '999.00',
        type: 'EXPENSE',
        kind: 'OTHER',
        createdById: seed.userId,
      },
    });

    await svc().resetStatement(seed.workspaceId, conn.id, seed.userId);

    const after = await h.prisma.transaction.findUniqueOrThrow({ where: { id: manual.id } });
    expect(after.deletedAt).toBeNull();
  });

  it('чужое подключение сбросить нельзя', async () => {
    const conn = await makeConnection();
    await expect(svc().resetStatement('чужое-пространство', conn.id, seed.userId)).rejects.toThrow(
      /не найдено/,
    );
    expect(await h.prisma.bankStatementLine.count({ where: { connectionId: conn.id } })).toBe(0);
  });
});

/**
 * Ф2: тот же пайплайн, но провайдер — настоящий AlfaAdapter (сеть подменена).
 * Проверяем стык, который юнит-тест адаптера не видит: номер счёта и дата
 * подключения доезжают из БД в запрос к банку, а ответ банка превращается в
 * строки выписки и авто-проводку.
 */
describe('SyncService + AlfaAdapter', () => {
  const ACCOUNT_NUMBER = '40802810401300015422';

  function alfaSync(bodyByDay: Record<string, unknown>, calls: string[]) {
    const http: AlfaHttp = {
      configured: true,
      getJson: (url) => {
        calls.push(url);
        const day = new URL(url).searchParams.get('statementDate') ?? '';
        return Promise.resolve({
          status: 200,
          body: JSON.stringify(bodyByDay[day] ?? { transactions: [] }),
          headers: {},
        });
      },
    };
    const registry = new AdapterRegistry(new FakeBankAdapter(), { get: () => 'test' } as never);
    const adapter = new AlfaAdapter(
      http,
      { get: () => 'https://sandbox.alfabank.ru/api/jp' } as never,
      registry,
    );
    adapter.onModuleInit();
    return buildSync(registry);
  }

  it('выписка банка → строки Inbox; счёт и дата подключения ушли в запрос', async () => {
    const conn = await h.prisma.integrationConnection.create({
      data: {
        workspaceId: seed.workspaceId,
        provider: 'ALFA',
        accountId: seed.accountId,
        credentialEnc: crypto.encrypt('alfa-api-key-9876'),
        keyLast4: '9876',
        externalAccountId: ACCOUNT_NUMBER,
        createdById: seed.userId,
      },
    });
    const today = dayKey(new Date());
    const calls: string[] = [];
    const alfa = alfaSync(
      {
        [today]: {
          transactions: [
            {
              transactionId: 'alfa-1',
              direction: 'CREDIT',
              operationDate: `${today}T08:00:00Z`,
              paymentPurpose: 'Оплата по счёту 7',
              amount: { amount: 25000.4, currencyName: 'RUR' },
              rurTransfer: { payerName: 'ООО «Клиент»', payerInn: '7701234567' },
            },
          ],
        },
      },
      calls,
    );

    const res = await alfa.syncConnection(conn.id);
    expect(res).toEqual({ fetched: 1, created: 1, autoPosted: 0, adopted: 0 });

    const line = await h.prisma.bankStatementLine.findFirstOrThrow({
      where: { connectionId: conn.id },
    });
    expect(line.externalId).toBe('alfa-1');
    expect(line.direction).toBe('INCOME');
    expect(num(line.amount)).toBe(25000.4);
    expect(line.counterpartyName).toBe('ООО «Клиент»');
    expect(line.counterpartyInn).toBe('7701234567');
    expect(line.status).toBe('NEW');

    // Номер счёта подставлен в запрос; синк начался с дня создания подключения.
    expect(calls[0]).toContain(`accountNumber=${ACCOUNT_NUMBER}`);
    expect(new URL(calls[0]!).searchParams.get('statementDate')).toBe(dayKey(conn.createdAt));
  });

  it('подключение Альфы без номера счёта → ERROR с понятным текстом', async () => {
    const conn = await h.prisma.integrationConnection.create({
      data: {
        workspaceId: seed.workspaceId,
        provider: 'ALFA',
        accountId: seed.accountId,
        credentialEnc: crypto.encrypt('alfa-api-key-0000'),
        keyLast4: '0000',
        createdById: seed.userId,
      },
    });
    const alfa = alfaSync({}, []);

    await expect(alfa.syncConnection(conn.id)).rejects.toThrow(/номера расчётного счёта/);
    const after = await h.prisma.integrationConnection.findUniqueOrThrow({ where: { id: conn.id } });
    expect(after.status).toBe('ERROR');
  });
});
