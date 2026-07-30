import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildHarness, resetDb, seedBase, type Harness, type Seed } from '../test/money-harness';
import { CryptoService } from './crypto.service';
import { InboxService } from './inbox.service';

/**
 * Переводы между своими счетами: банк присылает две независимые строки, и без
 * склейки они задваивают обороты — расход и доход там, где деньги из бизнеса не
 * выходили. С двумя подключёнными банками это каждый перевод между ними.
 *
 * Проверяем главное: подтверждение пары даёт ОДИН перевод (две ноги + комиссия
 * при расхождении сумм), обе строки уходят из разбора, а ОПиУ и остатки счетов
 * остаются верными.
 */
const KEY32 = Buffer.alloc(32, 5).toString('base64');
const num = (v: { toString(): string }) => Number(v.toString());

let h: Harness;
let seed: Seed;
let inbox: InboxService;
let crypto: CryptoService;
let tg = 3400000n;

/** Второй счёт и подключение к нему — перевод всегда между двумя счетами. */
async function secondAccount(name = 'Т-Банк …7867') {
  const account = await h.accounts.create(seed.workspaceId, {
    name,
    type: 'BANK',
    openingBalance: '0',
  });
  const conn = await h.prisma.integrationConnection.create({
    data: {
      workspaceId: seed.workspaceId,
      provider: 'TBANK',
      accountId: account.id,
      credentialEnc: crypto.encrypt('token-2'),
      keyLast4: '2222',
      createdById: seed.userId,
    },
  });
  return { account, conn };
}

async function firstConnection() {
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
  externalId: string;
  amount: string;
  direction: 'INCOME' | 'EXPENSE';
  date?: string;
  description?: string;
}) {
  return h.prisma.bankStatementLine.create({
    data: {
      workspaceId: seed.workspaceId,
      connectionId: over.connectionId,
      externalId: over.externalId,
      date: new Date(over.date ?? '2026-07-10T12:00:00.000Z'),
      amount: over.amount,
      direction: over.direction,
      description: over.description ?? 'Перевод между своими счетами',
      status: 'NEW',
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

describe('подсказка «похоже на перевод»', () => {
  it('находит пару разных счетов и не предлагает лишнего', async () => {
    const a = await firstConnection();
    const { conn: b } = await secondAccount();
    await seedLine({ connectionId: a.id, externalId: 'out-1', amount: '100000.00', direction: 'EXPENSE' });
    await seedLine({
      connectionId: b.id,
      externalId: 'in-1',
      amount: '100000.00',
      direction: 'INCOME',
      date: '2026-07-11T09:00:00.000Z',
    });
    // Посторонняя операция: приход той же суммы, но на тот же счёт, что и расход.
    await seedLine({ connectionId: a.id, externalId: 'noise', amount: '100000.00', direction: 'INCOME' });

    const res = await inbox.transferCandidates(seed.workspaceId);

    expect(res.items).toHaveLength(1);
    expect(res.items[0]!.out.id).toBeDefined();
    expect(res.items[0]!.confidence).toBe('exact');
    expect(res.items[0]!.fee).toBe('0');
    expect(res.items[0]!.out.account.id).toBe(seed.accountId);
  });

  it('чужие строки в подсказку не попадают', async () => {
    const a = await firstConnection();
    const { conn: b } = await secondAccount();
    await seedLine({ connectionId: a.id, externalId: 'out-1', amount: '50000.00', direction: 'EXPENSE' });
    await seedLine({ connectionId: b.id, externalId: 'in-1', amount: '50000.00', direction: 'INCOME' });
    const other = await seedBase(h.prisma, tg + 600n);

    const res = await inbox.transferCandidates(other.workspaceId);
    expect(res.items).toEqual([]);
  });
});

describe('подтверждение перевода', () => {
  it('создаёт один перевод, обе строки уходят из разбора, обороты не задваиваются', async () => {
    const a = await firstConnection();
    const { account: second, conn: b } = await secondAccount();
    const out = await seedLine({
      connectionId: a.id,
      externalId: 'out-1',
      amount: '100000.00',
      direction: 'EXPENSE',
    });
    const inc = await seedLine({
      connectionId: b.id,
      externalId: 'in-1',
      amount: '100000.00',
      direction: 'INCOME',
      date: '2026-07-11T09:00:00.000Z',
    });

    const res = await inbox.confirmTransfer(seed.workspaceId, seed.userId, {
      outLineId: out.id,
      inLineId: inc.id,
    });

    expect(res.ok).toBe(true);
    expect(res.fee).toBe('0.00');

    // Ровно один перевод и ровно две ноги — комиссии не было.
    const transfers = await h.prisma.transfer.findMany({ where: { deletedAt: null } });
    expect(transfers).toHaveLength(1);
    const legs = await h.prisma.transaction.findMany({
      where: { transferGroupId: transfers[0]!.id, deletedAt: null },
    });
    expect(legs.map((l) => l.kind).sort()).toEqual(['TRANSFER_IN', 'TRANSFER_OUT']);
    expect(legs.every((l) => num(l.amount) === 100000)).toBe(true);

    // Строки привязаны к переводу, каждая — к своей ноге.
    const [outAfter, inAfter] = await Promise.all([
      h.prisma.bankStatementLine.findUniqueOrThrow({ where: { id: out.id } }),
      h.prisma.bankStatementLine.findUniqueOrThrow({ where: { id: inc.id } }),
    ]);
    expect(outAfter.status).toBe('RESOLVED');
    expect(inAfter.status).toBe('RESOLVED');
    expect(outAfter.transferId).toBe(transfers[0]!.id);
    expect(inAfter.transferId).toBe(transfers[0]!.id);
    expect(outAfter.transactionId).toBe(legs.find((l) => l.kind === 'TRANSFER_OUT')!.id);
    expect(inAfter.transactionId).toBe(legs.find((l) => l.kind === 'TRANSFER_IN')!.id);

    // Главное: деньги переместились между счетами, а не появились из ниоткуда.
    // Ноги TRANSFER_* исключены из ОПиУ по kind — это закреплено в
    // reports.e2e.integration.test.ts, здесь проверяем сами остатки.
    const movement = async (accountId: string) => {
      const rows = await h.prisma.transaction.findMany({
        where: { workspaceId: seed.workspaceId, accountId, deletedAt: null },
        select: { amount: true, type: true },
      });
      return rows.reduce((s, t) => s + (t.type === 'INCOME' ? num(t.amount) : -num(t.amount)), 0);
    };
    expect(await movement(seed.accountId)).toBe(-100000);
    expect(await movement(second.id)).toBe(100000);
  });

  it('расхождение сумм становится комиссией — отдельным расходом', async () => {
    const a = await firstConnection();
    const { conn: b } = await secondAccount();
    const out = await seedLine({
      connectionId: a.id,
      externalId: 'out-1',
      amount: '100300.00',
      direction: 'EXPENSE',
    });
    const inc = await seedLine({
      connectionId: b.id,
      externalId: 'in-1',
      amount: '100000.00',
      direction: 'INCOME',
    });

    const res = await inbox.confirmTransfer(seed.workspaceId, seed.userId, {
      outLineId: out.id,
      inLineId: inc.id,
    });

    expect(res.fee).toBe('300.00');
    const transfer = await h.prisma.transfer.findFirstOrThrow({ where: { deletedAt: null } });
    expect(num(transfer.fee)).toBe(300);
    // Комиссия — настоящий расход (не нога перевода), поэтому учитывается.
    const feeTx = await h.prisma.transaction.findFirstOrThrow({
      where: { transferGroupId: transfer.id, kind: 'VARIABLE_COST', deletedAt: null },
    });
    expect(num(feeTx.amount)).toBe(300);
    expect(feeTx.accountId).toBe(seed.accountId);
  });

  it('две строки одного счёта, неверные направления и повтор — отказ', async () => {
    const a = await firstConnection();
    const { conn: b } = await secondAccount();
    const out = await seedLine({ connectionId: a.id, externalId: 'o', amount: '10.00', direction: 'EXPENSE' });
    const sameAccountIn = await seedLine({
      connectionId: a.id,
      externalId: 'i-same',
      amount: '10.00',
      direction: 'INCOME',
    });
    const inc = await seedLine({ connectionId: b.id, externalId: 'i', amount: '10.00', direction: 'INCOME' });

    await expect(
      inbox.confirmTransfer(seed.workspaceId, seed.userId, {
        outLineId: out.id,
        inLineId: sameAccountIn.id,
      }),
    ).rejects.toThrow(/одном счёте/);
    // Направления перепутаны местами.
    await expect(
      inbox.confirmTransfer(seed.workspaceId, seed.userId, {
        outLineId: inc.id,
        inLineId: out.id,
      }),
    ).rejects.toThrow(/списание с одного счёта/);
    // Одна и та же строка дважды.
    await expect(
      inbox.confirmTransfer(seed.workspaceId, seed.userId, {
        outLineId: out.id,
        inLineId: out.id,
      }),
    ).rejects.toThrow(/две разные строки/);

    // После отказов обе строки остались на разборе.
    expect(await inbox.count(seed.workspaceId)).toEqual({ count: 3 });
  });

  it('пришло больше, чем ушло — отказ, строки остаются на разборе', async () => {
    const a = await firstConnection();
    const { conn: b } = await secondAccount();
    const out = await seedLine({ connectionId: a.id, externalId: 'o', amount: '100.00', direction: 'EXPENSE' });
    const inc = await seedLine({ connectionId: b.id, externalId: 'i', amount: '150.00', direction: 'INCOME' });

    await expect(
      inbox.confirmTransfer(seed.workspaceId, seed.userId, { outLineId: out.id, inLineId: inc.id }),
    ).rejects.toThrow(/больше, чем ушло/);
    expect(await inbox.count(seed.workspaceId)).toEqual({ count: 2 });
  });

  it('уже разобранную строку вторым переводом не забрать', async () => {
    const a = await firstConnection();
    const { conn: b } = await secondAccount();
    const out = await seedLine({ connectionId: a.id, externalId: 'o', amount: '100.00', direction: 'EXPENSE' });
    const inc = await seedLine({ connectionId: b.id, externalId: 'i', amount: '100.00', direction: 'INCOME' });
    await inbox.dismiss(seed.workspaceId, inc.id);

    await expect(
      inbox.confirmTransfer(seed.workspaceId, seed.userId, { outLineId: out.id, inLineId: inc.id }),
    ).rejects.toThrow(/уже обработана/);
    // Расход не должен зависнуть в RESOLVED из-за неудачной попытки.
    const outAfter = await h.prisma.bankStatementLine.findUniqueOrThrow({ where: { id: out.id } });
    expect(outAfter.status).toBe('NEW');
  });
});

describe('перевод на счёт без выписки (карты физлиц)', () => {
  it('одна строка-расход создаёт перевод, вторая нога — наша', async () => {
    const a = await firstConnection();
    const card = await h.accounts.create(seed.workspaceId, {
      name: 'ВБ Каменск …8975',
      type: 'BANK',
      openingBalance: '0',
    });
    const out = await seedLine({
      connectionId: a.id,
      externalId: 'out-card',
      amount: '30000.00',
      direction: 'EXPENSE',
      description: 'Перевод на карту',
    });

    const res = await inbox.markAsTransfer(seed.workspaceId, seed.userId, out.id, card.id);

    expect(res.ok).toBe(true);
    const transfer = await h.prisma.transfer.findFirstOrThrow({ where: { deletedAt: null } });
    expect(transfer.fromAccountId).toBe(seed.accountId);
    expect(transfer.toAccountId).toBe(card.id);
    const line = await h.prisma.bankStatementLine.findUniqueOrThrow({ where: { id: out.id } });
    expect(line.status).toBe('RESOLVED');
    expect(line.transferId).toBe(transfer.id);
    // Строка привязана именно к своей ноге — списанию.
    const leg = await h.prisma.transaction.findUniqueOrThrow({
      where: { id: line.transactionId! },
    });
    expect(leg.kind).toBe('TRANSFER_OUT');
    expect(leg.accountId).toBe(seed.accountId);
  });

  it('приход с карты разворачивает стороны перевода', async () => {
    const a = await firstConnection();
    const card = await h.accounts.create(seed.workspaceId, {
      name: 'ВБ Антропов …4510',
      type: 'BANK',
      openingBalance: '0',
    });
    const inc = await seedLine({
      connectionId: a.id,
      externalId: 'in-card',
      amount: '20000.00',
      direction: 'INCOME',
    });

    await inbox.markAsTransfer(seed.workspaceId, seed.userId, inc.id, card.id);

    const transfer = await h.prisma.transfer.findFirstOrThrow({ where: { deletedAt: null } });
    expect(transfer.fromAccountId).toBe(card.id);
    expect(transfer.toAccountId).toBe(seed.accountId);
  });

  it('счёт сам на себя — отказ, строка остаётся на разборе', async () => {
    const a = await firstConnection();
    const out = await seedLine({ connectionId: a.id, externalId: 'o', amount: '10.00', direction: 'EXPENSE' });

    await expect(
      inbox.markAsTransfer(seed.workspaceId, seed.userId, out.id, seed.accountId),
    ).rejects.toThrow(/сам на себя/);
    expect(await inbox.count(seed.workspaceId)).toEqual({ count: 1 });
  });

  it('чужой счёт как встречный — отказ, строка возвращается на разбор', async () => {
    const a = await firstConnection();
    const out = await seedLine({ connectionId: a.id, externalId: 'o', amount: '10.00', direction: 'EXPENSE' });
    const other = await seedBase(h.prisma, tg + 800n);

    await expect(
      inbox.markAsTransfer(seed.workspaceId, seed.userId, out.id, other.accountId),
    ).rejects.toThrow();
    const after = await h.prisma.bankStatementLine.findUniqueOrThrow({ where: { id: out.id } });
    expect(after.status).toBe('NEW');
    expect(await h.prisma.transfer.count({ where: { deletedAt: null } })).toBe(0);
  });
});
