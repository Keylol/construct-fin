import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildHarness, resetDb, seedBase, type Harness, type Seed } from '../test/money-harness';
import { CryptoService } from './crypto.service';
import { AdapterRegistry } from './adapter-registry';
import { SyncService } from './sync.service';
import { BalanceAnchorService } from '../account/balance-anchor.service';
import { InboxService } from './inbox.service';
import { computeRowHash } from '../common/import-hash';
import type {
  BankProviderAdapter,
  FetchStatementResult,
  RawBankLine,
} from './provider-adapter';

/**
 * Усыновление: строка выписки находит операцию, которую оператор внёс руками до
 * подключения банка, и привязывается к ней вместо создания второй такой же.
 *
 * Ради этого механизма перезалив истории вообще возможен: без него бэкфилл за
 * май–июль задвоил бы все 265 ручных операций, а «чистка базы перед перезаливом»
 * стоила бы склада, заказов и привязок оплат.
 */
const KEY32 = Buffer.alloc(32, 7).toString('base64');
const num = (v: { toString(): string }) => Number(v.toString());

/** Провайдер, отдающий ровно те строки, которые нужны тесту. */
class ScriptedAdapter implements BankProviderAdapter {
  readonly provider = 'FAKE' as const;
  constructor(private readonly lines: RawBankLine[]) {}
  fetchStatement(): Promise<FetchStatementResult> {
    return Promise.resolve({ lines: this.lines, nextCursor: 'done' });
  }
}

let h: Harness;
let seed: Seed;
let crypto: CryptoService;
let tg = 3100000n;

function line(over: Partial<RawBankLine> = {}): RawBankLine {
  return {
    externalId: over.externalId ?? 'ext-1',
    date: over.date ?? new Date('2026-05-14T00:00:00.000Z'),
    amount: over.amount ?? '38999.00',
    direction: over.direction ?? 'EXPENSE',
    counterpartyName: over.counterpartyName ?? 'ООО «Поставщик»',
    counterpartyInn: over.counterpartyInn ?? '7701234567',
    description: over.description ?? 'Оплата по счёту 42 за товар',
    ausnMark: over.ausnMark ?? 'EXPENSE',
  };
}

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

/** Операция, «внесённая руками»: без контрагента, как в реальном срезе прода. */
async function manualTx(over: {
  amount?: string;
  date?: string;
  type?: 'INCOME' | 'EXPENSE';
  kind?: 'OTHER' | 'COGS' | 'ORDER_PAYMENT';
  categoryId?: string;
  counterpartyId?: string;
  deleted?: boolean;
} = {}) {
  const category =
    over.categoryId ??
    (
      await h.categories.create(seed.workspaceId, {
        name: `Закупка товара ${Math.random().toString(36).slice(2, 7)}`,
        kind: over.type === 'INCOME' ? 'INCOME' : 'EXPENSE',
        isFixedCost: false,
        bucket: over.type === 'INCOME' ? 'REVENUE' : 'COGS',
      })
    ).id;
  return h.prisma.transaction.create({
    data: {
      workspaceId: seed.workspaceId,
      accountId: seed.accountId,
      date: new Date(over.date ?? '2026-05-13T12:00:00.000Z'),
      amount: over.amount ?? '38999.00',
      type: over.type ?? 'EXPENSE',
      kind: over.kind ?? 'OTHER',
      categoryId: category,
      counterpartyId: over.counterpartyId ?? null,
      description: 'Закупка товара',
      createdById: seed.userId,
      ...(over.deleted ? { deletedAt: new Date() } : {}),
    },
  });
}

function syncWith(lines: RawBankLine[]) {
  return new SyncService(
    h.prisma as never,
    crypto,
    // ScriptedAdapter не наследует FakeBankAdapter (у того теперь ещё и
    // остаток) — реестру важен только контракт BankProviderAdapter.
    new AdapterRegistry(new ScriptedAdapter(lines) as never, { get: () => 'test' } as never),
    new BalanceAnchorService(h.prisma as never),
  );
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
  seed = await seedBase(h.prisma, tg);
});

describe('усыновление ручных операций', () => {
  it('строка находит ручную операцию в окне ±5 дней и привязывается к ней', async () => {
    const tx = await manualTx({ date: '2026-05-13T12:00:00.000Z' });
    const conn = await makeConnection();

    // Банк датирует 14-м, оператор записал 13-м — разница в пределах окна.
    const res = await syncWith([line({ date: new Date('2026-05-14T00:00:00.000Z') })])
      .syncConnection(conn.id);

    expect(res.adopted).toBe(1);
    expect(res.autoPosted).toBe(0);
    // Вторая проводка не появилась — деньги не задвоились.
    expect(await h.prisma.transaction.count({ where: { deletedAt: null } })).toBe(1);

    const stored = await h.prisma.bankStatementLine.findFirstOrThrow({
      where: { connectionId: conn.id },
    });
    expect(stored.status).toBe('RESOLVED');
    expect(stored.transactionId).toBe(tx.id);
  });

  it('разметку человека не трогает, пустые поля дозаполняет из банка', async () => {
    const tx = await manualTx();
    const conn = await makeConnection();

    await syncWith([line()]).syncConnection(conn.id);

    const after = await h.prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } });
    // Категория и описание — как ввёл человек.
    expect(after.categoryId).toBe(tx.categoryId);
    expect(after.description).toBe('Закупка товара');
    // Контрагента у ручной записи не было — приехал из выписки, вместе с ИНН.
    expect(after.counterpartyId).not.toBeNull();
    const cp = await h.prisma.counterparty.findUniqueOrThrow({
      where: { id: after.counterpartyId! },
    });
    expect(cp.inn).toBe('7701234567');
    expect(cp.role).toBe('SUPPLIER');
    // Маркировка АУСН тоже дозаполнена (у ручной записи её не было).
    expect(after.ausnMark).toBe('EXPENSE');
  });

  it('при двух одинаковых суммах выигрывает совпадение по ИНН, а не близость даты', async () => {
    const known = await h.prisma.counterparty.create({
      data: { workspaceId: seed.workspaceId, name: 'ООО «Поставщик»', inn: '7701234567' },
    });
    // Ближе по дате — но контрагент чужой.
    await manualTx({ date: '2026-05-14T12:00:00.000Z' });
    // Дальше по дате — зато тот самый ИНН.
    const withInn = await manualTx({
      date: '2026-05-11T12:00:00.000Z',
      counterpartyId: known.id,
    });
    const conn = await makeConnection();

    await syncWith([line({ date: new Date('2026-05-14T00:00:00.000Z') })]).syncConnection(conn.id);

    const stored = await h.prisma.bankStatementLine.findFirstOrThrow({
      where: { connectionId: conn.id },
    });
    expect(stored.transactionId).toBe(withInn.id);
  });

  it('две строки одной суммы не съедают одну операцию — вторая идёт своим путём', async () => {
    await manualTx({ date: '2026-05-13T12:00:00.000Z' });
    const conn = await makeConnection();

    const res = await syncWith([
      line({ externalId: 'ext-1', date: new Date('2026-05-13T00:00:00.000Z') }),
      line({ externalId: 'ext-2', date: new Date('2026-05-13T00:00:00.000Z') }),
    ]).syncConnection(conn.id);

    expect(res.adopted).toBe(1);
    const lines = await h.prisma.bankStatementLine.findMany({
      where: { connectionId: conn.id },
      orderBy: { externalId: 'asc' },
    });
    expect(lines.map((l) => l.status)).toEqual(['RESOLVED', 'NEW']);
    // Вторая строка ждёт разбора и своей проводки пока не имеет.
    expect(lines[1]!.transactionId).toBeNull();
  });

  it('повторный синк не усыновляет второй раз (строка уже загружена)', async () => {
    await manualTx();
    const conn = await makeConnection();
    const sync = syncWith([line()]);

    await sync.syncConnection(conn.id);
    await h.prisma.integrationConnection.update({
      where: { id: conn.id },
      data: { syncCursor: null },
    });
    const second = await sync.syncConnection(conn.id);

    expect(second.adopted).toBe(0);
    expect(await h.prisma.bankStatementLine.count({ where: { connectionId: conn.id } })).toBe(1);
    expect(await h.prisma.transaction.count({ where: { deletedAt: null } })).toBe(1);
  });

  it('операция вне окна, другой суммы или направления — не кандидат', async () => {
    await manualTx({ date: '2026-05-01T12:00:00.000Z' }); // 13 дней от строки
    await manualTx({ amount: '40000.00' });
    await manualTx({ type: 'INCOME' });
    const conn = await makeConnection();

    const res = await syncWith([line()]).syncConnection(conn.id);

    expect(res.adopted).toBe(0);
    const stored = await h.prisma.bankStatementLine.findFirstOrThrow({
      where: { connectionId: conn.id },
    });
    expect(stored.status).toBe('NEW');
  });

  it('удалённая операция и неденежные виды (COGS) кандидатами не считаются', async () => {
    await manualTx({ deleted: true });
    await manualTx({ kind: 'COGS' });
    const conn = await makeConnection();

    const res = await syncWith([line()]).syncConnection(conn.id);
    expect(res.adopted).toBe(0);
  });

  it('операция, уже привязанная к другой строке, второй раз не усыновляется', async () => {
    const tx = await manualTx();
    const conn = await makeConnection();
    await syncWith([line({ externalId: 'ext-1' })]).syncConnection(conn.id);

    // Другое подключение (другой счёт-источник строк), та же операция-кандидат.
    const other = await h.prisma.integrationConnection.create({
      data: {
        workspaceId: seed.workspaceId,
        provider: 'TBANK',
        accountId: seed.accountId,
        credentialEnc: crypto.encrypt('token-2'),
        keyLast4: '9999',
        createdById: seed.userId,
      },
    });
    const res = await syncWith([line({ externalId: 'ext-2' })]).syncConnection(other.id);

    expect(res.adopted).toBe(0);
    const linked = await h.prisma.bankStatementLine.findMany({
      where: { transactionId: tx.id },
    });
    expect(linked).toHaveLength(1);
  });

  it('усыновлённую строку можно отвязать: операция остаётся, строка идёт на разбор', async () => {
    const tx = await manualTx();
    const conn = await makeConnection();
    await syncWith([line()]).syncConnection(conn.id);
    const stored = await h.prisma.bankStatementLine.findFirstOrThrow({
      where: { connectionId: conn.id },
    });

    const inbox = new InboxService(h.prisma as never, h.orders as never, h.rules as never, h.transfer as never, h.planning as never);
    await inbox.undo(seed.workspaceId, stored.id);

    const after = await h.prisma.bankStatementLine.findUniqueOrThrow({ where: { id: stored.id } });
    expect(after.status).toBe('NEW');
    expect(after.transactionId).toBeNull();
    // ВАЖНО: операция человека не удалена — отвязали только строку выписки.
    const txAfter = await h.prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } });
    expect(txAfter.deletedAt).toBeNull();
  });

  it('оплату заказа усыновляет и не превращает в обычную проводку', async () => {
    const client = await h.prisma.counterparty.create({
      data: { workspaceId: seed.workspaceId, name: 'Клиент', role: 'CLIENT' },
    });
    const order = await h.orders.create(seed.workspaceId, {
      phone: '+79000000000', clientId: client.id,
      items: [{ name: 'Товар', qty: '1', unitPrice: '15000' }],
    });
    await h.orders.addPayment(seed.workspaceId, order.id, seed.userId, {
      amount: '15000.00',
      accountId: seed.accountId,
      date: '2026-05-13T12:00:00.000Z',
    });
    const conn = await makeConnection();

    const res = await syncWith([
      line({ amount: '15000.00', direction: 'INCOME', date: new Date('2026-05-13T00:00:00.000Z') }),
    ]).syncConnection(conn.id);

    expect(res.adopted).toBe(1);
    const payment = await h.prisma.transaction.findFirstOrThrow({
      where: { workspaceId: seed.workspaceId, kind: 'ORDER_PAYMENT', deletedAt: null },
    });
    expect(num(payment.amount)).toBe(15000);
    // Оплата осталась оплатой заказа, дубля прихода не появилось.
    expect(
      await h.prisma.transaction.count({ where: { type: 'INCOME', deletedAt: null } }),
    ).toBe(1);
  });

  it('операцию из CSV-импорта узнаёт по отпечатку, даже когда дата разошлась', async () => {
    const conn = await makeConnection();
    const l = line({ date: new Date('2026-05-14T00:00:00.000Z') });
    // Импорт той же выгрузки: отпечаток считается по счёту, дню, сумме,
    // направлению, контрагенту и назначению — ровно как в CSV-импорте.
    const imported = await h.prisma.transaction.create({
      data: {
        workspaceId: seed.workspaceId,
        accountId: seed.accountId,
        date: l.date,
        amount: l.amount,
        type: l.direction,
        kind: 'OTHER',
        description: l.description,
        importHash: computeRowHash({
          workspaceId: seed.workspaceId,
          accountId: seed.accountId,
          date: l.date,
          amount: l.amount,
          type: l.direction,
          counterpartyName: l.counterpartyName ?? null,
          description: l.description ?? null,
        }),
        createdById: seed.userId,
      },
    });

    const res = await syncWith([l]).syncConnection(conn.id);

    expect(res.adopted).toBe(1);
    const stored = await h.prisma.bankStatementLine.findFirstOrThrow({
      where: { connectionId: conn.id },
    });
    expect(stored.transactionId).toBe(imported.id);
  });

  it('проводка из синка несёт отпечаток — повторный CSV-импорт увидит дубль', async () => {
    const cat = await h.categories.create(seed.workspaceId, {
      name: 'Закупка товара',
      kind: 'EXPENSE',
      isFixedCost: false,
      bucket: 'COGS',
    });
    await h.prisma.rule.create({
      data: {
        workspaceId: seed.workspaceId,
        name: 'ИНН → Закупка',
        appliesTo: 'BOTH',
        conditions: [{ type: 'COUNTERPARTY_INN_IN', values: ['7701234567'] }],
        actions: [{ type: 'SET_CATEGORY', categoryId: cat.id }],
      },
    });
    const conn = await makeConnection();
    const l = line();

    await syncWith([l]).syncConnection(conn.id);

    const tx = await h.prisma.transaction.findFirstOrThrow({
      where: { workspaceId: seed.workspaceId, deletedAt: null },
    });
    expect(tx.importHash).toBe(
      computeRowHash({
        workspaceId: seed.workspaceId,
        accountId: seed.accountId,
        date: l.date,
        amount: l.amount,
        type: l.direction,
        counterpartyName: l.counterpartyName ?? null,
        description: l.description ?? null,
      }),
    );
  });

  it('чужую операцию не усыновляет (изоляция пространств)', async () => {
    const other = await seedBase(h.prisma, tg + 400n);
    // Операция-двойник — в соседнем пространстве.
    await h.prisma.transaction.create({
      data: {
        workspaceId: other.workspaceId,
        accountId: other.accountId,
        date: new Date('2026-05-13T12:00:00.000Z'),
        amount: '38999.00',
        type: 'EXPENSE',
        kind: 'OTHER',
        description: 'Закупка товара',
        createdById: other.userId,
      },
    });
    const conn = await makeConnection();

    const res = await syncWith([line()]).syncConnection(conn.id);

    expect(res.adopted).toBe(0);
    const stored = await h.prisma.bankStatementLine.findFirstOrThrow({
      where: { connectionId: conn.id },
    });
    expect(stored.status).toBe('NEW');
  });

  it('правила на усыновлённую строку не действуют — разметка человека главнее', async () => {
    const tx = await manualTx();
    const other = await h.categories.create(seed.workspaceId, {
      name: 'Реклама и развитие',
      kind: 'EXPENSE',
      isFixedCost: false,
      bucket: 'VARIABLE',
    });
    await h.prisma.rule.create({
      data: {
        workspaceId: seed.workspaceId,
        name: 'ИНН → Реклама',
        appliesTo: 'BOTH',
        conditions: [{ type: 'COUNTERPARTY_INN_IN', values: ['7701234567'] }],
        actions: [{ type: 'SET_CATEGORY', categoryId: other.id }],
      },
    });
    const conn = await makeConnection();

    const res = await syncWith([line()]).syncConnection(conn.id);

    expect(res.adopted).toBe(1);
    expect(res.autoPosted).toBe(0);
    const after = await h.prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } });
    expect(after.categoryId).toBe(tx.categoryId); // правило категорию не переписало
  });
});
