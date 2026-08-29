import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildHarness, resetDb, seedBase, type Harness, type Seed } from '../test/money-harness';
import { CryptoService } from './crypto.service';
import { InboxService } from './inbox.service';

/**
 * Кредит и рассрочка приходят от банка одной строкой на сумму за вычетом
 * комиссии: клиент купил на 461 468, банк прислал 438 394,60. Привязать такую
 * строку «как есть» — значит оставить заказ вечно недоплаченным на комиссию,
 * поэтому в июле их доводили двумя ручными действиями (Жукова, Смирнов,
 * Галицков, Новаков — 4 случая из 21 заказа).
 *
 * Здесь проверяем, что привязка с блоком рассрочки закрывает заказ полностью,
 * комиссия становится отдельным расходом, а на счёт садится ровно сумма строки.
 */
const KEY32 = Buffer.alloc(32, 9).toString('base64');
const num = (v: { toString(): string }) => Number(v.toString());

const CREDIT =
  'Согласно договору 56650/26 от 23.04.2026 (Новаков Дмитрий Вячеславович, КБ "Ренессанс Кредит") НДС не облагается.';
const ACQUIRING =
  'Возм 667302152487 17.10.2025 ИП КАМЕНСКИЙ ИЛЬЯ ЮРЬЕ Р.09072026 К.4837.50 в т.ч. НДС 872.34';

let h: Harness;
let seed: Seed;
let inbox: InboxService;
let crypto: CryptoService;
let tg = 7200000n;

async function connection() {
  return h.prisma.integrationConnection.create({
    data: {
      workspaceId: seed.workspaceId,
      provider: 'TBANK',
      accountId: seed.accountId,
      credentialEnc: crypto.encrypt('token-1'),
      keyLast4: '3333',
      createdById: seed.userId,
    },
  });
}

async function seedLine(connectionId: string, amount: string, description: string) {
  return h.prisma.bankStatementLine.create({
    data: {
      workspaceId: seed.workspaceId,
      connectionId,
      externalId: `credit-${amount}`,
      date: new Date('2026-08-03T06:37:49.000Z'),
      amount,
      direction: 'INCOME',
      description,
      status: 'NEW',
    },
  });
}

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

describe('привязка кредитной строки к заказу', () => {
  it('заказ закрывается полностью, комиссия — отдельный расход, на счёт садится сумма строки', async () => {
    const conn = await connection();
    const line = await seedLine(conn.id, '438394.60', CREDIT);
    const order = await seedOrder('461468.00');

    await inbox.attachOrder(seed.workspaceId, seed.userId, line.id, {
      orderId: order.id,
      installment: { amount: '461468.00', fee: '23073.40' },
    });

    const fresh = await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(num(fresh.paidAmount)).toBe(461468);
    expect(fresh.paymentStatus).toBe('PAID');

    const payment = await h.prisma.transaction.findFirstOrThrow({
      where: { workspaceId: seed.workspaceId, kind: 'ORDER_PAYMENT' },
    });
    expect(num(payment.amount)).toBe(461468);
    // Дата берётся из выписки, а не «сегодня»: иначе выручка уедет в чужой месяц.
    expect(payment.date.toISOString()).toBe(line.date.toISOString());

    const fee = await h.prisma.transaction.findFirstOrThrow({
      where: { workspaceId: seed.workspaceId, kind: 'VARIABLE_COST' },
    });
    expect(num(fee.amount)).toBe(23073.4);
    expect(fee.orderId).toBe(order.id);

    expect(num(payment.amount) - num(fee.amount)).toBe(438394.6);

    const resolved = await h.prisma.bankStatementLine.findUniqueOrThrow({ where: { id: line.id } });
    expect(resolved.status).toBe('RESOLVED');
  });

  it('нетто обязано совпасть с суммой строки — иначе счёт разъедется с банком', async () => {
    const conn = await connection();
    const line = await seedLine(conn.id, '438394.60', CREDIT);
    const order = await seedOrder('461468.00');

    await expect(
      inbox.attachOrder(seed.workspaceId, seed.userId, line.id, {
        orderId: order.id,
        installment: { amount: '461468.00', fee: '20000.00' },
      }),
    ).rejects.toThrow(/должна равняться сумме строки/);

    // Строка осталась на разборе — ошибочный запрос ничего не съел.
    const untouched = await h.prisma.bankStatementLine.findUniqueOrThrow({ where: { id: line.id } });
    expect(untouched.status).toBe('NEW');
  });

  it('на возмещении с удержанной комиссией рассрочку не принимаем — комиссия учлась бы дважды', async () => {
    const conn = await connection();
    const line = await seedLine(conn.id, '147668.50', ACQUIRING);
    const order = await seedOrder('152506.00');

    await expect(
      inbox.attachOrder(seed.workspaceId, seed.userId, line.id, {
        orderId: order.id,
        installment: { amount: '152506.00', fee: '4837.50' },
      }),
    ).rejects.toThrow(/эквайринга/);
  });

  it('без блока рассрочки поведение прежнее — оплата на сумму строки', async () => {
    const conn = await connection();
    const line = await seedLine(conn.id, '438394.60', CREDIT);
    const order = await seedOrder('461468.00');

    await inbox.attachOrder(seed.workspaceId, seed.userId, line.id, { orderId: order.id });

    const fresh = await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(num(fresh.paidAmount)).toBe(438394.6);
    expect(fresh.paymentStatus).toBe('PARTIAL');
  });
});
