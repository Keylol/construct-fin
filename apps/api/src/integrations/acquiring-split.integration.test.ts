import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildHarness, resetDb, seedBase, type Harness, type Seed } from '../test/money-harness';
import { CryptoService } from './crypto.service';
import { InboxService } from './inbox.service';

/**
 * Торговое возмещение Альфы приходит уже за вычетом комиссии, а удержанное
 * написано в назначении: `… Р.09072026 К.4837.50 …`. Отдельной строки на
 * комиссию в выписке нет.
 *
 * Без расщепления заказ на 152 506 ₽ навсегда остаётся недоплаченным на 4 837,50
 * (мы это поймали на живом архиве Касьянова), а расход банка не виден нигде.
 * Здесь проверяем обратное: заказ закрывается полностью, комиссия становится
 * расходом, а сальдо по счёту сходится с тем, что банк реально зачислил.
 */
const KEY32 = Buffer.alloc(32, 9).toString('base64');
const num = (v: { toString(): string }) => Number(v.toString());

const ACQUIRING =
  'Возм 667302152487 17.10.2025 ИП КАМЕНСКИЙ ИЛЬЯ ЮРЬЕ Р.09072026 К.4837.50 в т.ч. НДС 872.34';
const SBP =
  'C302407260716138 Возм. по согл. в СБП № 667302152487 от RB ПК CONSTRUCTPC (AMD Ryzen 7 7800X3D)';

let h: Harness;
let seed: Seed;
let inbox: InboxService;
let crypto: CryptoService;
let tg = 7100000n;

async function connection() {
  return h.prisma.integrationConnection.create({
    data: {
      workspaceId: seed.workspaceId,
      provider: 'ALFA',
      accountId: seed.accountId,
      credentialEnc: crypto.encrypt('token-1'),
      keyLast4: '2222',
      createdById: seed.userId,
    },
  });
}

async function seedLine(connectionId: string, amount: string, description: string) {
  return h.prisma.bankStatementLine.create({
    data: {
      workspaceId: seed.workspaceId,
      connectionId,
      externalId: `line-${amount}-${description.slice(0, 8)}`,
      date: new Date('2026-07-09T10:00:00.000Z'),
      amount,
      direction: 'INCOME',
      description,
      status: 'NEW',
    },
  });
}

/** Заказ ровно на брутто-сумму клиента (зачисление + удержанная комиссия). */
async function seedOrder(total: string) {
  return h.prisma.order.create({
    data: {
      workspaceId: seed.workspaceId,
      number: `ORD-${total}`,
      title: 'ПК CONSTRUCTPC',
      status: 'OPEN',
      subtotal: total,
      totalAmount: total,
      paidAmount: '0',
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

describe('привязка возмещения с удержанной комиссией', () => {
  it('оплата идёт по брутто, комиссия — отдельным расходом, сальдо равно зачислению', async () => {
    const conn = await connection();
    const line = await seedLine(conn.id, '147668.50', ACQUIRING);
    const order = await seedOrder('152506.00');

    await inbox.attachOrder(seed.workspaceId, seed.userId, line.id, { orderId: order.id });

    const fresh = await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(num(fresh.paidAmount)).toBe(152506);
    expect(fresh.paymentStatus).toBe('PAID');

    const payment = await h.prisma.transaction.findFirstOrThrow({
      where: { workspaceId: seed.workspaceId, kind: 'ORDER_PAYMENT' },
    });
    expect(num(payment.amount)).toBe(152506);

    const fee = await h.prisma.transaction.findFirstOrThrow({
      where: { workspaceId: seed.workspaceId, type: 'EXPENSE' },
      include: { category: true },
    });
    expect(num(fee.amount)).toBe(4837.5);
    expect(fee.date.toISOString()).toBe(line.date.toISOString());
    expect(fee.category?.name).toContain('анковск');

    // Главная проверка: на счёте осталось ровно то, что пришло от банка.
    expect(num(payment.amount) - num(fee.amount)).toBe(147668.5);
  });

  it('комиссия садится в уже заведённую категорию, а не плодит вторую', async () => {
    const conn = await connection();
    const existing = await h.prisma.category.create({
      data: {
        workspaceId: seed.workspaceId,
        name: 'Банковские услуги',
        kind: 'EXPENSE',
        bucket: 'VARIABLE',
      },
    });
    const line = await seedLine(conn.id, '147668.50', ACQUIRING);
    const order = await seedOrder('152506.00');

    await inbox.attachOrder(seed.workspaceId, seed.userId, line.id, { orderId: order.id });

    const fee = await h.prisma.transaction.findFirstOrThrow({
      where: { workspaceId: seed.workspaceId, type: 'EXPENSE' },
    });
    expect(fee.categoryId).toBe(existing.id);
    expect(await h.prisma.category.count({ where: { workspaceId: seed.workspaceId } })).toBe(1);
  });

  it('возмещение по СБП не расщепляется — там комиссия приходит своей строкой', async () => {
    const conn = await connection();
    const line = await seedLine(conn.id, '114207.32', SBP);
    const order = await seedOrder('114207.32');

    await inbox.attachOrder(seed.workspaceId, seed.userId, line.id, { orderId: order.id });

    const fresh = await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(num(fresh.paidAmount)).toBe(114207.32);
    expect(
      await h.prisma.transaction.count({ where: { workspaceId: seed.workspaceId, type: 'EXPENSE' } }),
    ).toBe(0);
  });
});
