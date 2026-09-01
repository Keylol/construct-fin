import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildHarness, resetDb, seedBase, type Harness, type Seed } from '../test/money-harness';
import { CryptoService } from '../integrations/crypto.service';
import { InboxService } from '../integrations/inbox.service';

/**
 * Удаление заказа, оплаченного строкой из выписки.
 *
 * Заказ удаляют, когда его завели по ошибке — тестовый, дубль архива, платёж
 * прицепился к чужому клиенту. Проводки при этом уходят в soft-delete, и если
 * оставить строку выписки помеченной обработанной, деньги пропадают с остатка
 * счёта безвозвратно: вернуть строку из «Входящих» нечем, undo там требует
 * живой проводки. Поэтому строка обязана вернуться на разбор.
 */
const KEY32 = Buffer.alloc(32, 9).toString('base64');
const num = (v: { toString(): string }) => Number(v.toString());

let h: Harness;
let seed: Seed;
let inbox: InboxService;
let crypto: CryptoService;
let tg = 7300000n;

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

describe('удаление заказа', () => {
  it('возвращает строку выписки на разбор и снимает её проводку', async () => {
    const conn = await h.prisma.integrationConnection.create({
      data: {
        workspaceId: seed.workspaceId,
        provider: 'TBANK',
        accountId: seed.accountId,
        credentialEnc: crypto.encrypt('token-1'),
        keyLast4: '3333',
        createdById: seed.userId,
      },
    });
    const line = await h.prisma.bankStatementLine.create({
      data: {
        workspaceId: seed.workspaceId,
        connectionId: conn.id,
        externalId: 'del-1',
        date: new Date('2026-08-03T06:37:49.000Z'),
        amount: '120000.00',
        direction: 'INCOME',
        description: 'Оплата по счёту',
        status: 'NEW',
      },
    });
    const order = await h.prisma.order.create({
      data: {
        workspaceId: seed.workspaceId,
        number: 'ORD-DEL-1',
        status: 'OPEN',
        subtotal: '120000.00',
        totalAmount: '120000.00',
        paidAmount: '0',
      },
    });

    await inbox.attachOrder(seed.workspaceId, seed.userId, line.id, { orderId: order.id });
    const attached = await h.prisma.bankStatementLine.findUniqueOrThrow({ where: { id: line.id } });
    expect(attached.status).toBe('RESOLVED');
    expect(attached.transactionId).not.toBeNull();

    await h.orders.remove(seed.workspaceId, order.id, seed.userId);

    const back = await h.prisma.bankStatementLine.findUniqueOrThrow({ where: { id: line.id } });
    expect(back.status).toBe('NEW');
    expect(back.transactionId).toBeNull();
    expect(back.adopted).toBe(false);
    // Сумма строки не тронута — её перепривяжут к правильному заказу.
    expect(num(back.amount)).toBe(120000);

    const payments = await h.prisma.transaction.findMany({
      where: { workspaceId: seed.workspaceId, orderId: order.id, deletedAt: null },
    });
    expect(payments).toHaveLength(0);

    const deleted = await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(deleted.deletedAt).not.toBeNull();
  });

  it('заказ без строк выписки удаляется как прежде', async () => {
    const order = await h.prisma.order.create({
      data: {
        workspaceId: seed.workspaceId,
        number: 'ORD-DEL-2',
        status: 'OPEN',
        subtotal: '5000.00',
        totalAmount: '5000.00',
        paidAmount: '0',
      },
    });

    await h.orders.remove(seed.workspaceId, order.id, seed.userId);

    const deleted = await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(deleted.deletedAt).not.toBeNull();
  });
});
