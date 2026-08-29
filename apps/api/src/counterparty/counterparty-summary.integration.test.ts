import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildHarness, resetDb, seedBase, type Harness, type Seed } from '../test/money-harness';
import { CounterpartyService } from './counterparty.service';

/**
 * Плитка клиента живёт этой сводкой: сколько заказов, на какую сумму и сколько
 * он должен сейчас. Без неё за клиентом нельзя следить, не открывая карточку.
 */
let h: Harness;
let seed: Seed;
let service: CounterpartyService;
let tg = 7300000n;

beforeAll(() => {
  h = buildHarness();
  service = new CounterpartyService(h.prisma as never);
});
afterAll(async () => {
  await h.prisma.$disconnect();
});
beforeEach(async () => {
  await resetDb(h.prisma);
  tg += 1n;
  seed = await seedBase(h.prisma, tg);
});

async function client(name: string) {
  return h.prisma.counterparty.create({
    data: { workspaceId: seed.workspaceId, name, role: 'CLIENT' },
  });
}

describe('сводка контрагента для плитки', () => {
  it('считает заказы, оборот и текущий долг', async () => {
    const c = await client('Иванов Иван');
    await h.orders.create(seed.workspaceId, {
      phone: '+79000000001',
      clientId: c.id,
      items: [{ name: 'Сборка', qty: '1', unitPrice: '100000', unitCost: '70000' }],
    });
    const second = await h.orders.create(seed.workspaceId, {
      phone: '+79000000001',
      clientId: c.id,
      items: [{ name: 'Апгрейд', qty: '1', unitPrice: '50000', unitCost: '30000' }],
    });
    await h.orders.addPayment(seed.workspaceId, second.id, seed.userId, {
      amount: '50000',
      accountId: seed.accountId,
    });

    const list = await service.list(seed.workspaceId, {} as never);
    const row = list.find((x) => x.id === c.id);
    expect(row?.summary).toMatchObject({
      ordersCount: 2,
      ordersTotal: '150000.00',
      // Оплачен только второй — долг остался по первому.
      debt: '100000.00',
    });
    expect(row?.summary.lastOrderAt).not.toBeNull();
  });

  it('клиент без заказов показывается с нулями, а не пропадает', async () => {
    const c = await client('Новый клиент');
    const list = await service.list(seed.workspaceId, {} as never);
    const row = list.find((x) => x.id === c.id);
    expect(row?.summary).toEqual({
      ordersCount: 0,
      ordersTotal: '0.00',
      debt: '0.00',
      lastOrderAt: null,
    });
  });

  it('отменённый заказ в сводку не входит', async () => {
    const c = await client('Отменённый');
    const o = await h.orders.create(seed.workspaceId, {
      phone: '+79000000002',
      clientId: c.id,
      items: [{ name: 'Сборка', qty: '1', unitPrice: '80000' }],
    });
    await h.orders.cancel(seed.workspaceId, o.id, seed.userId);

    const list = await service.list(seed.workspaceId, {} as never);
    expect(list.find((x) => x.id === c.id)?.summary.ordersCount).toBe(0);
  });
});
