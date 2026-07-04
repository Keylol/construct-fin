/**
 * E2E (DB-backed) интеграционные тесты домена «Торговые отчёты».
 *
 * Покрывают сквозной путь ПО ДАННЫМ: завести заказы/позиции/контрагентов в
 * реальной БД (construct_v6_test) → вызвать MarginService / ReceivablesService →
 * проверить агрегаты, группировку, сортировку, edge-кейсы и гварды.
 *
 * Augment к unit-сьютам margin.service.test.ts / receivables.service.test.ts:
 * здесь проверяется реальная выборка из Postgres (фильтры status/deletedAt/
 * paymentStatus, join Counterparty, снапшот OrderItem.name), а не моки.
 *
 * Отчётные сервисы — read-only. Чтобы детерминированно контролировать вход
 * (status=DONE, unitCostAtSale, paidAmount, createdAt), позиции/заказы пишем
 * напрямую через prisma — механику finalize/WAVG проверяют orders/*-сьюты.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  buildHarness,
  resetDb,
  seedBase,
  type Harness,
  type Seed,
} from '../test/money-harness';

let h: Harness;
let seed: Seed;
let tg = 1600000n; // уникальный диапазон telegramId для этого файла

const num = (v: { toString(): string }) => Number(v.toString());

beforeAll(() => {
  h = buildHarness();
});

afterAll(async () => {
  await h.prisma.$disconnect();
});

beforeEach(async () => {
  await resetDb(h.prisma);
  tg += 1n;
  seed = await seedBase(h.prisma, tg);
});

// ───────────────────────────── helpers ─────────────────────────────

let orderSeq = 0;

type ItemInput = {
  name: string;
  qty: string;
  unitPrice: string;
  /** unitCostAtSale (себестоимость на момент продажи); undefined → null. */
  cost?: string;
  /** unitCost (ручная себестоимость позиции); undefined → null. */
  unitCost?: string;
  warehouseItemId?: string | null;
};

/** Создаёт DONE-заказ с позициями напрямую (минуя finalize) для margin-отчётов. */
async function makeDoneOrder(opts: {
  clientId?: string | null;
  items: ItemInput[];
  closedAt?: Date;
}) {
  orderSeq += 1;
  return h.prisma.order.create({
    data: {
      workspaceId: seed.workspaceId,
      number: `ORD-${orderSeq}`,
      clientId: opts.clientId ?? null,
      status: 'DONE',
      paymentStatus: 'PAID',
      closedAt: opts.closedAt ?? new Date(),
      items: {
        create: opts.items.map((it) => ({
          warehouseItemId: it.warehouseItemId ?? null,
          name: it.name,
          qty: new Prisma.Decimal(it.qty),
          unitPrice: new Prisma.Decimal(it.unitPrice),
          unitCostAtSale: it.cost != null ? new Prisma.Decimal(it.cost) : null,
          unitCost: it.unitCost != null ? new Prisma.Decimal(it.unitCost) : null,
          lineTotal: new Prisma.Decimal(it.qty).times(it.unitPrice),
        })),
      },
    },
  });
}

/** Создаёт открытый/частично оплаченный заказ для receivables. */
async function makeReceivableOrder(opts: {
  clientId?: string | null;
  total: string;
  paid: string;
  paymentStatus: 'UNPAID' | 'PARTIAL' | 'PAID' | 'OVERPAID' | 'REFUNDED';
  createdAt: Date;
  status?: 'OPEN' | 'DONE' | 'CANCELLED';
  deletedAt?: Date | null;
}) {
  orderSeq += 1;
  return h.prisma.order.create({
    data: {
      workspaceId: seed.workspaceId,
      number: `REC-${orderSeq}`,
      clientId: opts.clientId ?? null,
      status: opts.status ?? 'OPEN',
      paymentStatus: opts.paymentStatus,
      subtotal: new Prisma.Decimal(opts.total),
      totalAmount: new Prisma.Decimal(opts.total),
      paidAmount: new Prisma.Decimal(opts.paid),
      createdAt: opts.createdAt,
      deletedAt: opts.deletedAt ?? null,
    },
  });
}

async function makeClient(name: string, role: 'CLIENT' | 'SUPPLIER' = 'CLIENT') {
  const c = await h.prisma.counterparty.create({
    data: { workspaceId: seed.workspaceId, name, role },
  });
  return c.id;
}

const DAY = 86_400_000;
const daysAgo = (n: number, from = Date.now()) => new Date(from - n * DAY);

// ══════════════════════════ Margin by Product ══════════════════════════

describe('Trade Reports E2E · Margin by Product', () => {
  it('BR1: услуга с ручным unitCost (без unitCostAtSale) → маржа не 100%', async () => {
    await makeDoneOrder({
      items: [{ name: 'Монтаж', qty: '1', unitPrice: '1000', unitCost: '600' }], // cost(unitCostAtSale)=null
    });
    const rep = await h.tradeMargin.byProduct(seed.workspaceId);
    const row = rep.rows.find((r) => r.name === 'Монтаж')!;
    expect(num(row.cogs)).toBe(600); // взят fallback на unitCost
    expect(num(row.margin)).toBe(400);
    expect(row.marginPct).toBe('40.00');
  });

  it('BR3: фильтр периода по closedAt — заказы вне периода не учитываются', async () => {
    await makeDoneOrder({
      items: [{ name: 'Старьё', qty: '1', unitPrice: '1000', cost: '300' }],
      closedAt: new Date('2026-01-15T12:00:00.000Z'),
    });
    await makeDoneOrder({
      items: [{ name: 'Свежак', qty: '1', unitPrice: '1000', cost: '300' }],
      closedAt: new Date('2026-06-15T12:00:00.000Z'),
    });
    const period = { from: new Date('2026-06-01T00:00:00.000Z'), to: new Date('2026-06-30T23:59:59.000Z') };
    const rep = await h.tradeMargin.byProduct(seed.workspaceId, period);
    expect(rep.rows).toHaveLength(1);
    expect(rep.rows[0]!.name).toBe('Свежак');
    // без периода — оба
    expect((await h.tradeMargin.byProduct(seed.workspaceId)).rows).toHaveLength(2);
  });

  it('агрегирует выручку/COGS/маржу из DONE-заказов и сортирует по убыванию маржи', async () => {
    // Высокомаржинальный товар.
    await makeDoneOrder({
      items: [{ name: 'Стол', qty: '2', unitPrice: '1000', cost: '400' }],
    });
    // Низкомаржинальный товар.
    await makeDoneOrder({
      items: [{ name: 'Гвозди', qty: '100', unitPrice: '5', cost: '4' }],
    });

    const rep = await h.tradeMargin.byProduct(seed.workspaceId);

    expect(rep.method).toBe('by-product');
    expect(rep.rows).toHaveLength(2);
    // Сортировка по абс. марже убыванием: Стол (1200) выше Гвоздей (100).
    expect(rep.rows[0]!.name).toBe('Стол');
    expect(rep.rows[1]!.name).toBe('Гвозди');

    const stol = rep.rows[0]!;
    expect(num(stol.revenue)).toBe(2000); // 2 * 1000
    expect(num(stol.cogs)).toBe(800); // 2 * 400
    expect(num(stol.margin)).toBe(1200);
    expect(stol.marginPct).toBe('60.00'); // 1200/2000
    expect(num(stol.qty)).toBe(2);

    // Итоги.
    expect(num(rep.totals.revenue)).toBe(2500); // 2000 + 500
    expect(num(rep.totals.cogs)).toBe(1200); // 800 + 400
    expect(num(rep.totals.margin)).toBe(1300);
    expect(rep.totals.marginPct).toBe('52.00'); // 1300/2500
  });

  it('одинаковые имена позиций из РАЗНЫХ заказов группируются в одну строку (по name)', async () => {
    await makeDoneOrder({ items: [{ name: 'Болт', qty: '10', unitPrice: '50', cost: '20' }] });
    await makeDoneOrder({ items: [{ name: 'Болт', qty: '5', unitPrice: '50', cost: '20' }] });

    const rep = await h.tradeMargin.byProduct(seed.workspaceId);

    expect(rep.rows).toHaveLength(1);
    const row = rep.rows[0]!;
    expect(row.name).toBe('Болт');
    expect(num(row.qty)).toBe(15); // 10 + 5
    expect(num(row.revenue)).toBe(750); // 15 * 50
    expect(num(row.cogs)).toBe(300); // 15 * 20
    expect(num(row.margin)).toBe(450);
  });

  it('группировка по name, а не по warehouseItemId: одно имя при разных SKU → одна строка', async () => {
    await makeDoneOrder({
      items: [
        { name: 'Услуга монтаж', qty: '1', unitPrice: '300', cost: '0', warehouseItemId: null },
        { name: 'Услуга монтаж', qty: '2', unitPrice: '300', cost: '0', warehouseItemId: null },
      ],
    });

    const rep = await h.tradeMargin.byProduct(seed.workspaceId);
    expect(rep.rows).toHaveLength(1);
    expect(num(rep.rows[0]!.qty)).toBe(3);
    expect(num(rep.rows[0]!.revenue)).toBe(900);
  });

  it('unitCostAtSale=null → COGS=0 → 100% маржа (услуга без себестоимости)', async () => {
    await makeDoneOrder({
      items: [{ name: 'Консультация', qty: '1', unitPrice: '5000' /* cost undefined → null */ }],
    });

    const rep = await h.tradeMargin.byProduct(seed.workspaceId);
    const row = rep.rows[0]!;
    expect(num(row.cogs)).toBe(0);
    expect(num(row.margin)).toBe(5000);
    expect(row.marginPct).toBe('100.00');
  });

  it('игнорирует НЕ-DONE заказы (OPEN), soft-deleted заказы и удалённые позиции', async () => {
    // OPEN — не попадает.
    await h.prisma.order.create({
      data: {
        workspaceId: seed.workspaceId,
        number: 'OPEN-1',
        status: 'OPEN',
        paymentStatus: 'UNPAID',
        items: {
          create: [
            {
              name: 'Невидимый OPEN',
              qty: new Prisma.Decimal('1'),
              unitPrice: new Prisma.Decimal('999'),
              lineTotal: new Prisma.Decimal('999'),
            },
          ],
        },
      },
    });
    // Soft-deleted DONE — не попадает.
    await h.prisma.order.create({
      data: {
        workspaceId: seed.workspaceId,
        number: 'DEL-1',
        status: 'DONE',
        paymentStatus: 'PAID',
        deletedAt: new Date(),
        items: {
          create: [
            {
              name: 'Невидимый удалённый заказ',
              qty: new Prisma.Decimal('1'),
              unitPrice: new Prisma.Decimal('999'),
              lineTotal: new Prisma.Decimal('999'),
            },
          ],
        },
      },
    });
    // DONE с soft-deleted позицией — позиция не попадает.
    const ord = await makeDoneOrder({
      items: [
        { name: 'Видимый', qty: '1', unitPrice: '100', cost: '40' },
        { name: 'Удалённая позиция', qty: '1', unitPrice: '777', cost: '0' },
      ],
    });
    const items = await h.prisma.orderItem.findMany({ where: { orderId: ord.id } });
    const del = items.find((i) => i.name === 'Удалённая позиция')!;
    await h.prisma.orderItem.update({ where: { id: del.id }, data: { deletedAt: new Date() } });

    const rep = await h.tradeMargin.byProduct(seed.workspaceId);
    expect(rep.rows.map((r) => r.name)).toEqual(['Видимый']);
    expect(num(rep.totals.revenue)).toBe(100);
  });

  it('пустой воркспейс → нет строк, нулевые итоги, marginPct=0.00 (деление на ноль защищено)', async () => {
    const rep = await h.tradeMargin.byProduct(seed.workspaceId);
    expect(rep.rows).toHaveLength(0);
    expect(num(rep.totals.revenue)).toBe(0);
    expect(num(rep.totals.margin)).toBe(0);
    expect(rep.totals.marginPct).toBe('0.00');
  });

  it('изоляция воркспейсов: DONE-заказы чужого воркспейса не учитываются', async () => {
    tg += 1n;
    const other = await seedBase(h.prisma, tg);
    await h.prisma.order.create({
      data: {
        workspaceId: other.workspaceId,
        number: 'OTH-1',
        status: 'DONE',
        paymentStatus: 'PAID',
        items: {
          create: [
            {
              name: 'Чужой товар',
              qty: new Prisma.Decimal('1'),
              unitPrice: new Prisma.Decimal('1000'),
              lineTotal: new Prisma.Decimal('1000'),
            },
          ],
        },
      },
    });
    await makeDoneOrder({ items: [{ name: 'Свой товар', qty: '1', unitPrice: '100', cost: '50' }] });

    const rep = await h.tradeMargin.byProduct(seed.workspaceId);
    expect(rep.rows.map((r) => r.name)).toEqual(['Свой товар']);
  });
});

// ══════════════════════════ Margin by Client ══════════════════════════

describe('Trade Reports E2E · Margin by Client', () => {
  it('группирует маржу по клиенту, резолвит имя из Counterparty, сортирует по убыванию маржи', async () => {
    const a = await makeClient('Альфа');
    const b = await makeClient('Бета');
    // Альфа: маржа 600.
    await makeDoneOrder({ clientId: a, items: [{ name: 'X', qty: '1', unitPrice: '1000', cost: '400' }] });
    // Бета: маржа 100.
    await makeDoneOrder({ clientId: b, items: [{ name: 'Y', qty: '1', unitPrice: '200', cost: '100' }] });

    const rep = await h.tradeMargin.byClient(seed.workspaceId);
    expect(rep.method).toBe('by-client');
    expect(rep.rows).toHaveLength(2);
    expect(rep.rows[0]!.name).toBe('Альфа');
    expect(rep.rows[0]!.key).toBe(a);
    expect(num(rep.rows[0]!.margin)).toBe(600);
    expect(rep.rows[1]!.name).toBe('Бета');
    expect(num(rep.rows[1]!.margin)).toBe(100);
  });

  it('заказы без clientId группируются в «Без клиента» (key=null)', async () => {
    await makeDoneOrder({ clientId: null, items: [{ name: 'Розница', qty: '3', unitPrice: '100', cost: '60' }] });

    const rep = await h.tradeMargin.byClient(seed.workspaceId);
    expect(rep.rows).toHaveLength(1);
    expect(rep.rows[0]!.key).toBeNull();
    expect(rep.rows[0]!.name).toBe('Без клиента');
    expect(num(rep.rows[0]!.margin)).toBe(120); // 3*(100-60)
  });

  it('несколько заказов одного клиента суммируются в одну строку', async () => {
    const c = await makeClient('Гамма');
    await makeDoneOrder({ clientId: c, items: [{ name: 'P1', qty: '1', unitPrice: '500', cost: '200' }] });
    await makeDoneOrder({ clientId: c, items: [{ name: 'P2', qty: '2', unitPrice: '300', cost: '100' }] });

    const rep = await h.tradeMargin.byClient(seed.workspaceId);
    expect(rep.rows).toHaveLength(1);
    const row = rep.rows[0]!;
    expect(row.name).toBe('Гамма');
    expect(num(row.revenue)).toBe(1100); // 500 + 600
    expect(num(row.cogs)).toBe(400); // 200 + 200
    expect(num(row.margin)).toBe(700);
  });

  it('clientId указывает на отсутствующего в выборке контрагента → имя «—», заказ учитывается', async () => {
    // Заказ ссылается на clientId, которого нет в Counterparty этого воркспейса.
    // Воспроизводим осиротевшую ссылку напрямую (минуя FK SetNull): создаём
    // контрагента в ДРУГОМ воркспейсе — byClient фильтрует Counterparty по
    // workspaceId, поэтому имя не резолвится → fallback '—'.
    tg += 1n;
    const otherWs = await seedBase(h.prisma, tg);
    const foreignClient = await h.prisma.counterparty.create({
      data: { workspaceId: otherWs.workspaceId, name: 'Чужой контрагент', role: 'CLIENT' },
    });
    await h.prisma.order.create({
      data: {
        workspaceId: seed.workspaceId,
        number: 'PHANTOM-1',
        clientId: foreignClient.id, // ссылка валидна по FK, но из другого воркспейса
        status: 'DONE',
        paymentStatus: 'PAID',
        items: {
          create: [
            {
              name: 'Z',
              qty: new Prisma.Decimal('1'),
              unitPrice: new Prisma.Decimal('300'),
              unitCostAtSale: new Prisma.Decimal('100'),
              lineTotal: new Prisma.Decimal('300'),
            },
          ],
        },
      },
    });

    const rep = await h.tradeMargin.byClient(seed.workspaceId);
    expect(rep.rows).toHaveLength(1);
    expect(rep.rows[0]!.key).toBe(foreignClient.id);
    expect(rep.rows[0]!.name).toBe('—'); // findMany(workspaceId) не нашёл → fallback '—'
    expect(num(rep.rows[0]!.margin)).toBe(200);
  });
});

// ══════════════════════════ Receivables with Aging ══════════════════════════

describe('Trade Reports E2E · Receivables with Aging', () => {
  it('собирает долг (total−paid) только по UNPAID/PARTIAL и раскладывает по корзинам возраста', async () => {
    const asOf = new Date('2026-06-14T12:00:00Z');
    const c = await makeClient('Должник');

    // 0-30: возраст 10 дней, долг 1000.
    await makeReceivableOrder({
      clientId: c, total: '1000', paid: '0', paymentStatus: 'UNPAID',
      createdAt: daysAgo(10, asOf.getTime()),
    });
    // 30-60: возраст 45 дней, частично оплачен, долг 500.
    await makeReceivableOrder({
      clientId: c, total: '800', paid: '300', paymentStatus: 'PARTIAL',
      createdAt: daysAgo(45, asOf.getTime()),
    });
    // 60+: возраст 90 дней, долг 2000.
    await makeReceivableOrder({
      clientId: c, total: '2000', paid: '0', paymentStatus: 'UNPAID',
      createdAt: daysAgo(90, asOf.getTime()),
    });

    const rep = await h.tradeReceivables.build(seed.workspaceId, asOf);

    expect(num(rep.totalDue)).toBe(3500); // 1000 + 500 + 2000
    expect(num(rep.buckets['0-30'])).toBe(1000);
    expect(num(rep.buckets['30-60'])).toBe(500);
    expect(num(rep.buckets['60+'])).toBe(2000);

    expect(rep.clients).toHaveLength(1);
    const client = rep.clients[0]!;
    expect(client.clientName).toBe('Должник');
    expect(num(client.due)).toBe(3500);
    expect(client.orders).toHaveLength(3);
    // Заказы внутри клиента — по убыванию ageDays.
    expect(client.orders.map((o) => o.ageDays)).toEqual([90, 45, 10]);
    expect(client.orders[0]!.bucket).toBe('60+');
    expect(num(client.orders[1]!.due)).toBe(500);
  });

  it('исключает PAID/REFUNDED/OVERPAID, soft-deleted заказы и нулевой/отрицательный долг', async () => {
    const asOf = new Date('2026-06-14T12:00:00Z');
    const c = await makeClient('К1');
    // Учитывается.
    await makeReceivableOrder({
      clientId: c, total: '500', paid: '0', paymentStatus: 'UNPAID', createdAt: daysAgo(5, asOf.getTime()),
    });
    // PAID — отфильтрован по paymentStatus.
    await makeReceivableOrder({
      clientId: c, total: '1000', paid: '1000', paymentStatus: 'PAID', createdAt: daysAgo(5, asOf.getTime()),
    });
    // OVERPAID — отфильтрован.
    await makeReceivableOrder({
      clientId: c, total: '1000', paid: '1200', paymentStatus: 'OVERPAID', createdAt: daysAgo(5, asOf.getTime()),
    });
    // REFUNDED — отфильтрован.
    await makeReceivableOrder({
      clientId: c, total: '1000', paid: '0', paymentStatus: 'REFUNDED', createdAt: daysAgo(5, asOf.getTime()),
    });
    // PARTIAL, но due<=0 (рассинхрон кэша paidAmount) — пропускается гвардом due>0.
    await makeReceivableOrder({
      clientId: c, total: '300', paid: '300', paymentStatus: 'PARTIAL', createdAt: daysAgo(5, asOf.getTime()),
    });
    // UNPAID, но soft-deleted — отфильтрован по deletedAt.
    await makeReceivableOrder({
      clientId: c, total: '900', paid: '0', paymentStatus: 'UNPAID', createdAt: daysAgo(5, asOf.getTime()),
      deletedAt: new Date(),
    });

    const rep = await h.tradeReceivables.build(seed.workspaceId, asOf);
    expect(num(rep.totalDue)).toBe(500); // только первый
    expect(rep.clients).toHaveLength(1);
    expect(rep.clients[0]!.orders).toHaveLength(1);
  });

  it('граница 30 дней попадает в корзину 30-60; 60 дней → 60+ (ageDays<30 / <60 / иначе)', async () => {
    const asOf = new Date('2026-06-14T12:00:00Z');
    // Ровно 30 дней.
    await makeReceivableOrder({
      total: '100', paid: '0', paymentStatus: 'UNPAID', createdAt: daysAgo(30, asOf.getTime()),
    });
    // Ровно 60 дней.
    await makeReceivableOrder({
      total: '200', paid: '0', paymentStatus: 'UNPAID', createdAt: daysAgo(60, asOf.getTime()),
    });
    // 29 дней → 0-30.
    await makeReceivableOrder({
      total: '50', paid: '0', paymentStatus: 'UNPAID', createdAt: daysAgo(29, asOf.getTime()),
    });

    const rep = await h.tradeReceivables.build(seed.workspaceId, asOf);
    expect(num(rep.buckets['0-30'])).toBe(50);
    expect(num(rep.buckets['30-60'])).toBe(100); // 30 дней
    expect(num(rep.buckets['60+'])).toBe(200); // 60 дней
  });

  it('заказ в будущем (asOf раньше createdAt) → ageDays=0, корзина 0-30', async () => {
    const asOf = new Date('2026-06-14T12:00:00Z');
    await makeReceivableOrder({
      total: '400', paid: '0', paymentStatus: 'UNPAID',
      createdAt: new Date(asOf.getTime() + 5 * DAY), // на 5 дней в будущем
    });

    const rep = await h.tradeReceivables.build(seed.workspaceId, asOf);
    expect(rep.clients[0]!.orders[0]!.ageDays).toBe(0);
    expect(rep.clients[0]!.orders[0]!.bucket).toBe('0-30');
    expect(num(rep.buckets['0-30'])).toBe(400);
  });

  it('заказы без clientId → «Без клиента» (clientId=null)', async () => {
    const asOf = new Date('2026-06-14T12:00:00Z');
    await makeReceivableOrder({
      clientId: null, total: '700', paid: '0', paymentStatus: 'UNPAID', createdAt: daysAgo(3, asOf.getTime()),
    });

    const rep = await h.tradeReceivables.build(seed.workspaceId, asOf);
    expect(rep.clients).toHaveLength(1);
    expect(rep.clients[0]!.clientId).toBeNull();
    expect(rep.clients[0]!.clientName).toBe('Без клиента');
    expect(num(rep.clients[0]!.due)).toBe(700);
  });

  it('клиенты сортируются по убыванию суммарного долга', async () => {
    const asOf = new Date('2026-06-14T12:00:00Z');
    const small = await makeClient('Малый долг');
    const big = await makeClient('Большой долг');
    await makeReceivableOrder({
      clientId: small, total: '100', paid: '0', paymentStatus: 'UNPAID', createdAt: daysAgo(1, asOf.getTime()),
    });
    await makeReceivableOrder({
      clientId: big, total: '5000', paid: '1000', paymentStatus: 'PARTIAL', createdAt: daysAgo(1, asOf.getTime()),
    });

    const rep = await h.tradeReceivables.build(seed.workspaceId, asOf);
    expect(rep.clients.map((c) => c.clientName)).toEqual(['Большой долг', 'Малый долг']);
    expect(num(rep.clients[0]!.due)).toBe(4000); // 5000 - 1000
  });

  it('asOf по умолчанию = now(): свежий заказ попадает в 0-30 и в отчёт', async () => {
    await makeReceivableOrder({
      total: '250', paid: '0', paymentStatus: 'UNPAID', createdAt: new Date(),
    });

    const rep = await h.tradeReceivables.build(seed.workspaceId); // без asOf
    expect(num(rep.totalDue)).toBe(250);
    expect(num(rep.buckets['0-30'])).toBe(250);
    // asOf сериализован как ISO-строка «сейчас».
    expect(typeof rep.asOf).toBe('string');
  });

  it('изоляция воркспейсов: долги чужого воркспейса не попадают в отчёт', async () => {
    const asOf = new Date('2026-06-14T12:00:00Z');
    tg += 1n;
    const other = await seedBase(h.prisma, tg);
    await h.prisma.order.create({
      data: {
        workspaceId: other.workspaceId,
        number: 'OTHREC-1',
        status: 'OPEN',
        paymentStatus: 'UNPAID',
        totalAmount: new Prisma.Decimal('9999'),
        paidAmount: new Prisma.Decimal('0'),
        createdAt: daysAgo(2, asOf.getTime()),
      },
    });
    await makeReceivableOrder({
      total: '300', paid: '0', paymentStatus: 'UNPAID', createdAt: daysAgo(2, asOf.getTime()),
    });

    const rep = await h.tradeReceivables.build(seed.workspaceId, asOf);
    expect(num(rep.totalDue)).toBe(300);
  });
});

describe('Trade Reports E2E · Волна 3 согласованность (IJ1, DE1, DE2)', () => {
  it('IJ1: маржа by-client вычитает скидку заказа из выручки', async () => {
    const clientId = await makeClient('ООО Скидка');
    // Заказ: 10 × 1000 = 10000, скидка 1000 → выручка должна быть 9000.
    orderSeq += 1;
    await h.prisma.order.create({
      data: {
        workspaceId: seed.workspaceId,
        number: `ORD-DISC-${orderSeq}`,
        clientId,
        status: 'DONE',
        paymentStatus: 'PAID',
        closedAt: new Date(),
        subtotal: new Prisma.Decimal('10000'),
        discountAmount: new Prisma.Decimal('1000'),
        totalAmount: new Prisma.Decimal('9000'),
        items: {
          create: [
            {
              name: 'Товар',
              qty: new Prisma.Decimal('10'),
              unitPrice: new Prisma.Decimal('1000'),
              unitCostAtSale: new Prisma.Decimal('600'),
              lineTotal: new Prisma.Decimal('10000'),
            },
          ],
        },
      },
    });
    const rep = await h.tradeMargin.byClient(seed.workspaceId);
    const row = rep.rows.find((r) => r.key === clientId)!;
    // Выручка 10000 − скидка 1000 = 9000; COGS 10×600=6000; маржа 3000.
    expect(row.revenue).toBe('9000.00');
    expect(row.cogs).toBe('6000.00');
    expect(row.margin).toBe('3000.00');
    expect(rep.totals.revenue).toBe('9000.00');
  });

  it('DE1: возврат товара не создаёт фантомный долг в дебиторке', async () => {
    const asOf = new Date('2026-06-01T00:00:00.000Z');
    orderSeq += 1;
    // Заказ 2000 (2×1000), оплачен полностью, вернули 1 единицу (стоимость 1000).
    // paidAmount упал бы до 1000 (рефанд), но netRevenue = 2000 − 1000 = 1000.
    // Старая формула: due = 2000 − 1000 = 1000 (фантом). Новая: 1000 − 1000 = 0.
    await h.prisma.order.create({
      data: {
        workspaceId: seed.workspaceId,
        number: `REC-RMA-${orderSeq}`,
        status: 'DONE',
        paymentStatus: 'PARTIAL', // статус-кэш «недоплачен» (фантом до пересчёта)
        subtotal: new Prisma.Decimal('2000'),
        totalAmount: new Prisma.Decimal('2000'),
        paidAmount: new Prisma.Decimal('1000'),
        createdAt: daysAgo(5, asOf.getTime()),
        items: {
          create: [
            {
              name: 'Товар',
              qty: new Prisma.Decimal('2'),
              returnedQty: new Prisma.Decimal('1'), // 1 возвращена
              unitPrice: new Prisma.Decimal('1000'),
              lineTotal: new Prisma.Decimal('2000'),
            },
          ],
        },
      },
    });
    const rep = await h.tradeReceivables.build(seed.workspaceId, asOf);
    // netRevenue 1000 − paid 1000 = 0 → долга нет (фантом исчез).
    expect(num(rep.totalDue)).toBe(0);
  });

  it('DE2: отменённый заказ (CANCELLED) не висит в дебиторке', async () => {
    const asOf = new Date('2026-06-01T00:00:00.000Z');
    await makeReceivableOrder({
      total: '5000',
      paid: '0',
      paymentStatus: 'UNPAID',
      status: 'CANCELLED',
      createdAt: daysAgo(90, asOf.getTime()),
    });
    // Плюс живой долг для контроля.
    await makeReceivableOrder({
      total: '700',
      paid: '0',
      paymentStatus: 'UNPAID',
      status: 'OPEN',
      createdAt: daysAgo(3, asOf.getTime()),
    });
    const rep = await h.tradeReceivables.build(seed.workspaceId, asOf);
    // Только живой OPEN-долг 700; CANCELLED 5000 исключён.
    expect(num(rep.totalDue)).toBe(700);
  });
});
