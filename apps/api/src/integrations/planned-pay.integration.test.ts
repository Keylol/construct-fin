import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildHarness, resetDb, seedBase, type Harness, type Seed } from '../test/money-harness';
import { CryptoService } from './crypto.service';
import { InboxService } from './inbox.service';

/**
 * Гашение плановых платежей строками выписки. Без этой связки оплата, на
 * которую заведён план, задваивается: строка из банка становится обычной
 * проводкой, план продолжает висеть «ожидается», и его закрывают руками второй
 * проводкой. Первый же синк месяца аренды — ровно этот сценарий.
 */
const KEY32 = Buffer.alloc(32, 6).toString('base64');
const num = (v: { toString(): string }) => Number(v.toString());

let h: Harness;
let seed: Seed;
let inbox: InboxService;
let crypto: CryptoService;
let tg = 3600000n;

async function connection() {
  return h.prisma.integrationConnection.create({
    data: {
      workspaceId: seed.workspaceId,
      provider: 'ALFA',
      accountId: seed.accountId,
      credentialEnc: crypto.encrypt('token-1'),
      keyLast4: '1111',
      createdById: seed.userId,
    },
  });
}

async function seedLine(over: {
  connectionId: string;
  externalId?: string;
  amount?: string;
  direction?: 'INCOME' | 'EXPENSE';
  date?: string;
  inn?: string | null;
}) {
  return h.prisma.bankStatementLine.create({
    data: {
      workspaceId: seed.workspaceId,
      connectionId: over.connectionId,
      externalId: over.externalId ?? 'line-1',
      date: new Date(over.date ?? '2026-08-05T10:00:00.000Z'),
      amount: over.amount ?? '45000.00',
      direction: over.direction ?? 'EXPENSE',
      counterpartyName: 'ООО «Арендодатель»',
      counterpartyInn: over.inn === undefined ? '7701234567' : over.inn,
      description: 'Оплата аренды за август',
      ausnMark: 'EXPENSE',
      status: 'NEW',
    },
  });
}

async function seedPlan(over: {
  title?: string;
  amount?: string;
  dueDate?: string;
  categoryId?: string | null;
  counterpartyId?: string | null;
  status?: 'PLANNED' | 'PAID';
} = {}) {
  return h.prisma.plannedPayment.create({
    data: {
      workspaceId: seed.workspaceId,
      title: over.title ?? 'Аренда август',
      amount: over.amount ?? '45000.00',
      txKind: 'FIXED_COST',
      dueDate: new Date(over.dueDate ?? '2026-08-05T00:00:00.000Z'),
      source: 'MANUAL',
      status: over.status ?? 'PLANNED',
      categoryId: over.categoryId ?? null,
      counterpartyId: over.counterpartyId ?? null,
      createdById: seed.userId,
    },
  });
}

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

describe('подсказка «похоже на плановый платёж»', () => {
  it('находит план по сумме и окну срока, чужие пространства не видит', async () => {
    const conn = await connection();
    await seedLine({ connectionId: conn.id });
    const plan = await seedPlan();
    // Шум: другая сумма и уже оплаченный план.
    await seedPlan({ title: 'Связь', amount: '1200.00' });
    await seedPlan({ title: 'Оплачено', status: 'PAID' });

    const res = await inbox.plannedSuggestions(seed.workspaceId);
    expect(res.items).toHaveLength(1);
    expect(res.items[0]!.plan.id).toBe(plan.id);
    expect(res.items[0]!.plan.title).toBe('Аренда август');

    const other = await seedBase(h.prisma, tg + 500n);
    expect((await inbox.plannedSuggestions(other.workspaceId)).items).toEqual([]);
  });
});

describe('гашение плана строкой', () => {
  it('создаёт проводку с видом/категорией плана, закрывает план привязкой', async () => {
    const cat = await h.prisma.category.create({
      data: { workspaceId: seed.workspaceId, name: 'Аренда', kind: 'EXPENSE', bucket: 'FIXED' },
    });
    const cp = await h.prisma.counterparty.create({
      data: { workspaceId: seed.workspaceId, name: 'Арендодатель', inn: '7701234567' },
    });
    const conn = await connection();
    const line = await seedLine({ connectionId: conn.id });
    const plan = await seedPlan({ categoryId: cat.id, counterpartyId: cp.id });

    const res = await inbox.payPlannedFromLine(seed.workspaceId, seed.userId, line.id, plan.id);
    expect(res.ok).toBe(true);

    const tx = await h.prisma.transaction.findUniqueOrThrow({
      where: { id: res.transactionId! },
    });
    // Вид и категория — из плана; сумма, дата и АУСН — из банка.
    expect(tx.kind).toBe('FIXED_COST');
    expect(tx.categoryId).toBe(cat.id);
    expect(tx.counterpartyId).toBe(cp.id);
    expect(num(tx.amount)).toBe(45000);
    expect(tx.ausnMark).toBe('EXPENSE');
    expect(tx.importHash).not.toBeNull();

    const planAfter = await h.prisma.plannedPayment.findUniqueOrThrow({ where: { id: plan.id } });
    expect(planAfter.status).toBe('PAID');
    expect(planAfter.matchedTransactionId).toBe(tx.id);
    // Привязка, а не авто-создание: отмена плана не должна удалить проводку строки.
    expect(planAfter.autoTx).toBe(false);

    const lineAfter = await h.prisma.bankStatementLine.findUniqueOrThrow({ where: { id: line.id } });
    expect(lineAfter.status).toBe('RESOLVED');
    expect(lineAfter.transactionId).toBe(tx.id);
  });

  it('план уже оплачен → отказ, строка возвращается на разбор, проводка не задваивается', async () => {
    const conn = await connection();
    const line = await seedLine({ connectionId: conn.id });
    const plan = await seedPlan({ status: 'PAID' });

    await expect(
      inbox.payPlannedFromLine(seed.workspaceId, seed.userId, line.id, plan.id),
    ).rejects.toThrow(/уже оплачен/);

    const lineAfter = await h.prisma.bankStatementLine.findUniqueOrThrow({ where: { id: line.id } });
    expect(lineAfter.status).toBe('NEW');
    expect(await h.prisma.transaction.count({ where: { deletedAt: null } })).toBe(0);
  });

  it('поступлением план не гасится', async () => {
    const conn = await connection();
    const line = await seedLine({ connectionId: conn.id, direction: 'INCOME' });
    const plan = await seedPlan();
    await expect(
      inbox.payPlannedFromLine(seed.workspaceId, seed.userId, line.id, plan.id),
    ).rejects.toThrow(/списанием/);
  });

  it('чужой план → 404, строка не тронута', async () => {
    const other = await seedBase(h.prisma, tg + 700n);
    const foreignPlan = await h.prisma.plannedPayment.create({
      data: {
        workspaceId: other.workspaceId,
        title: 'Чужой план',
        amount: '45000.00',
        txKind: 'FIXED_COST',
        dueDate: new Date('2026-08-05T00:00:00.000Z'),
        source: 'MANUAL',
        createdById: other.userId,
      },
    });
    const conn = await connection();
    const line = await seedLine({ connectionId: conn.id });

    await expect(
      inbox.payPlannedFromLine(seed.workspaceId, seed.userId, line.id, foreignPlan.id),
    ).rejects.toThrow(/не найден/);
    expect(
      (await h.prisma.bankStatementLine.findUniqueOrThrow({ where: { id: line.id } })).status,
    ).toBe('NEW');
  });

  it('отмена разбора строки возвращает план в «ожидается», проводка гасится', async () => {
    const conn = await connection();
    const line = await seedLine({ connectionId: conn.id });
    const plan = await seedPlan();
    const res = await inbox.payPlannedFromLine(seed.workspaceId, seed.userId, line.id, plan.id);

    await inbox.undo(seed.workspaceId, line.id);

    const planAfter = await h.prisma.plannedPayment.findUniqueOrThrow({ where: { id: plan.id } });
    expect(planAfter.status).toBe('PLANNED');
    expect(planAfter.matchedTransactionId).toBeNull();
    const tx = await h.prisma.transaction.findUniqueOrThrow({ where: { id: res.transactionId! } });
    expect(tx.deletedAt).not.toBeNull();
    expect(
      (await h.prisma.bankStatementLine.findUniqueOrThrow({ where: { id: line.id } })).status,
    ).toBe('NEW');
  });
});

describe('отмена перевода возвращает его строки на разбор', () => {
  it('softDelete перевода отвязывает подтверждённые строки', async () => {
    // Вторая сторона перевода.
    const account2 = await h.accounts.create(seed.workspaceId, {
      name: 'Т-Банк …7867',
      type: 'BANK',
      class: 'OPERATING',
      openingBalance: '0',
    });
    const conn1 = await connection();
    const conn2 = await h.prisma.integrationConnection.create({
      data: {
        workspaceId: seed.workspaceId,
        provider: 'TBANK',
        accountId: account2.id,
        credentialEnc: crypto.encrypt('token-2'),
        keyLast4: '2222',
        createdById: seed.userId,
      },
    });
    const out = await seedLine({ connectionId: conn1.id, externalId: 'o', amount: '10000.00' });
    const inc = await h.prisma.bankStatementLine.create({
      data: {
        workspaceId: seed.workspaceId,
        connectionId: conn2.id,
        externalId: 'i',
        date: new Date('2026-08-05T12:00:00.000Z'),
        amount: '10000.00',
        direction: 'INCOME',
        status: 'NEW',
      },
    });
    const confirmed = await inbox.confirmTransfer(seed.workspaceId, seed.userId, {
      outLineId: out.id,
      inLineId: inc.id,
    });

    await h.transfer.softDelete(seed.workspaceId, confirmed.transferId);

    const lines = await h.prisma.bankStatementLine.findMany({
      where: { id: { in: [out.id, inc.id] } },
    });
    // Обе строки снова на разборе, без ссылок на погашенные ноги.
    expect(lines.every((l) => l.status === 'NEW')).toBe(true);
    expect(lines.every((l) => l.transactionId === null && l.transferId === null)).toBe(true);
  });
});
