import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildHarness, resetDb, seedBase, type Harness, type Seed } from '../test/money-harness';
import { CryptoService } from './crypto.service';
import { AdapterRegistry } from './adapter-registry';
import { FakeBankAdapter } from './adapters/fake-bank.adapter';
import { SyncService } from './sync.service';

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
    expect(res).toEqual({ fetched: 0, created: 0, autoPosted: 0 });
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
