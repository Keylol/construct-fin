/**
 * F4 (решение #10): списание со склада против реальной БД construct_v6_test.
 *
 * Проверяет весь контракт: FIFO-списание лотов + StockMovement(WRITE_OFF,
 * reason) + НЕДЕНЕЖНАЯ проводка-убыток kind=WRITE_OFF на фактическую
 * стоимость; потеря видна в P&L (бакет COGS), но кассу не двигает (R2).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { buildHarness, resetDb, seedBase, type Harness, type Seed } from '../test/money-harness';

let h: Harness;
let seed: Seed;
let tg = 2740000n;

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

const PERIOD = {
  from: new Date('2026-01-01T00:00:00.000Z'),
  to: new Date('2026-12-31T23:59:59.999Z'),
};

/** Партии A (5@100, раньше) и B (5@200, позже) — как в каноническом FIFO-стенде. */
async function setupAB() {
  const wh = await h.warehouse.create(seed.workspaceId, { name: 'Деталь' }, seed.userId);
  const warehouseItemId = wh!.id;
  await h.purchases.register(seed.workspaceId, seed.userId, {
    accountId: seed.accountId,
    date: '2026-01-01T00:00:00.000Z',
    lines: [{ warehouseItemId, qty: '5', unitPrice: '100' }],
  });
  await h.purchases.register(seed.workspaceId, seed.userId, {
    accountId: seed.accountId,
    date: '2026-02-01T00:00:00.000Z',
    lines: [{ warehouseItemId, qty: '5', unitPrice: '200' }],
  });
  return warehouseItemId;
}

describe('F4: списание со склада (WRITE_OFF)', () => {
  it('FIFO-списание + движение с причиной + неденежная проводка на факт-стоимость', async () => {
    const itemId = await setupAB();

    const after = await h.warehouse.writeOff(
      seed.workspaceId,
      itemId,
      { qty: '3', reason: 'Бой при разгрузке' },
      seed.userId,
    );
    // Остаток: 10 − 3 = 7; FIFO списал из партии A → её remaining 2.
    expect(after!.qty.toString()).toBe('7');
    const lots = await h.prisma.stockLot.findMany({
      where: { warehouseItemId: itemId, deletedAt: null },
      orderBy: { receivedAt: 'asc' },
    });
    expect(lots.map((l) => l.qtyRemaining.toString())).toEqual(['2', '5']);

    // Движение WRITE_OFF с причиной и FIFO-стоимостью единицы (3×100 → 100/ед).
    const move = await h.prisma.stockMovement.findFirstOrThrow({
      where: { warehouseItemId: itemId, type: 'WRITE_OFF' },
    });
    expect(move.qtyDelta.toString()).toBe('-3');
    expect(move.qtyAfter.toString()).toBe('7');
    expect(move.reason).toBe('Бой при разгрузке');

    // Проводка-убыток: EXPENSE kind=WRITE_OFF на 300.00 (3 × 100, партия A).
    const tx = await h.prisma.transaction.findFirstOrThrow({
      where: { workspaceId: seed.workspaceId, kind: 'WRITE_OFF', deletedAt: null },
    });
    expect(tx.type).toBe('EXPENSE');
    expect(tx.amount.toFixed(2)).toBe('300.00');
    expect(tx.description).toContain('Деталь');
    expect(tx.description).toContain('Бой при разгрузке');
  });

  it('через границу партий: 6 ед = 5@100 + 1@200 → убыток 700.00', async () => {
    const itemId = await setupAB();
    await h.warehouse.writeOff(
      seed.workspaceId,
      itemId,
      { qty: '6', reason: 'Затопило' },
      seed.userId,
    );
    const tx = await h.prisma.transaction.findFirstOrThrow({
      where: { workspaceId: seed.workspaceId, kind: 'WRITE_OFF', deletedAt: null },
    });
    expect(tx.amount.toFixed(2)).toBe('700.00'); // 5×100 + 1×200
  });

  it('P&L: убыток в бакете COGS (валовая прибыль падает); касса не тронута (R2)', async () => {
    const itemId = await setupAB();
    await h.warehouse.writeOff(
      seed.workspaceId,
      itemId,
      { qty: '3', reason: 'Брак' },
      seed.userId,
    );

    const pnl = await h.pnl.build({
      workspaceId: seed.workspaceId,
      primary: PERIOD,
      comparison: null,
      groupBy: 'month',
    });
    // COGS-бакет = убыток списания (продаж не было).
    expect(pnl.primary.totals.cogs).toBe('300.00');
    expect(pnl.primary.totals.grossProfit).toBe('-300.00');

    // Касса: единственные реальные движения — закупки 500+1000; списание не двигает.
    const cf = await h.cashflow.build({
      workspaceId: seed.workspaceId,
      period: PERIOD,
      accountId: null,
      mode: 'consolidated',
    });
    const outflow = cf.series[0]!.points.reduce(
      (acc, p) => acc.plus(p.outflow),
      new Prisma.Decimal(0),
    );
    expect(outflow.toFixed(2)).toBe('1500.00');
  });

  it('нехватка остатка → 400, ни движение, ни проводка не создаются', async () => {
    const itemId = await setupAB();
    await expect(
      h.warehouse.writeOff(
        seed.workspaceId,
        itemId,
        { qty: '11', reason: 'Ошибка' },
        seed.userId,
      ),
    ).rejects.toThrow(/Недостаточно на складе/);

    expect(
      await h.prisma.stockMovement.count({
        where: { warehouseItemId: itemId, type: 'WRITE_OFF' },
      }),
    ).toBe(0);
    expect(
      await h.prisma.transaction.count({
        where: { workspaceId: seed.workspaceId, kind: 'WRITE_OFF' },
      }),
    ).toBe(0);
  });

  it('неоценённый остаток (cost 0): движение есть, проводки-пустышки нет', async () => {
    const wh = await h.warehouse.create(
      seed.workspaceId,
      { name: 'Опенинг', openingQty: '4' }, // openingCost не задан → лот 0
      seed.userId,
    );
    await h.warehouse.writeOff(
      seed.workspaceId,
      wh!.id,
      { qty: '2', reason: 'Недостача' },
      seed.userId,
    );
    expect(
      await h.prisma.stockMovement.count({
        where: { warehouseItemId: wh!.id, type: 'WRITE_OFF' },
      }),
    ).toBe(1);
    expect(
      await h.prisma.transaction.count({
        where: { workspaceId: seed.workspaceId, kind: 'WRITE_OFF' },
      }),
    ).toBe(0);
  });
});
