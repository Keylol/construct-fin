import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { MarginService } from './margin.service';

/**
 * Юнит-тесты маржи. PrismaService мокается плейн-объектом — БД не нужна.
 * Проверяем: маржа считается из unitCostAtSale; позиция с COGS=0 → 100% маржи;
 * группировки by-product / by-client.
 */

function item(over: {
  name: string;
  qty: string;
  unitPrice: string;
  unitCostAtSale: string | null;
  returnedQty?: string;
  clientId?: string | null;
}) {
  return {
    name: over.name,
    qty: new Prisma.Decimal(over.qty),
    returnedQty: new Prisma.Decimal(over.returnedQty ?? '0'),
    unitPrice: new Prisma.Decimal(over.unitPrice),
    unitCostAtSale: over.unitCostAtSale === null ? null : new Prisma.Decimal(over.unitCostAtSale),
    order: { clientId: over.clientId ?? null },
  };
}

function buildService(
  items: ReturnType<typeof item>[],
  clients: { id: string; name: string }[] = [],
) {
  const prisma = {
    orderItem: { findMany: vi.fn().mockResolvedValue(items) },
    counterparty: { findMany: vi.fn().mockResolvedValue(clients) },
  };
  return { service: new MarginService(prisma as never), prisma };
}

describe('MarginService.byProduct', () => {
  it('считает выручку/COGS/маржу из unitCostAtSale', async () => {
    const { service } = buildService([
      item({ name: 'Стол', qty: '2', unitPrice: '1000', unitCostAtSale: '600' }),
    ]);
    const r = await service.byProduct('ws1');
    const row = r.rows.find((x) => x.name === 'Стол')!;
    expect(row.revenue).toBe('2000.00'); // 2*1000
    expect(row.cogs).toBe('1200.00'); // 2*600
    expect(row.margin).toBe('800.00');
    expect(row.marginPct).toBe('40.00'); // 800/2000*100
    expect(r.totals.margin).toBe('800.00');
  });

  it('позиция с unitCostAtSale=0 → 100% маржи', async () => {
    const { service } = buildService([
      item({ name: 'Услуга', qty: '1', unitPrice: '500', unitCostAtSale: '0' }),
    ]);
    const r = await service.byProduct('ws1');
    const row = r.rows[0]!;
    expect(row.cogs).toBe('0.00');
    expect(row.marginPct).toBe('100.00');
  });

  it('unitCostAtSale=null трактуется как 0 (100% маржи)', async () => {
    const { service } = buildService([
      item({ name: 'Консультация', qty: '3', unitPrice: '100', unitCostAtSale: null }),
    ]);
    const r = await service.byProduct('ws1');
    const row = r.rows[0]!;
    expect(row.cogs).toBe('0.00');
    expect(row.revenue).toBe('300.00');
    expect(row.marginPct).toBe('100.00');
  });

  it('возврат клиента (RMA) сужает маржу: считаем по qty − returnedQty (A4)', async () => {
    // Продали 5 по 1000 (себест. 600), вернули 2 → чистая продажа 3 шт.
    const { service } = buildService([
      item({ name: 'Стол', qty: '5', returnedQty: '2', unitPrice: '1000', unitCostAtSale: '600' }),
    ]);
    const r = await service.byProduct('ws1');
    const row = r.rows[0]!;
    expect(row.qty).toBe('3.000'); // 5 − 2
    expect(row.revenue).toBe('3000.00'); // 3*1000 (не 5000)
    expect(row.cogs).toBe('1800.00'); // 3*600
    expect(row.margin).toBe('1200.00');
  });

  it('полный возврат позиции → нулевые выручка/COGS/маржа', async () => {
    const { service } = buildService([
      item({ name: 'Стол', qty: '2', returnedQty: '2', unitPrice: '1000', unitCostAtSale: '600' }),
    ]);
    const r = await service.byProduct('ws1');
    const row = r.rows[0]!;
    expect(row.qty).toBe('0.000');
    expect(row.revenue).toBe('0.00');
    expect(row.cogs).toBe('0.00');
    expect(row.margin).toBe('0.00');
  });

  it('агрегирует одинаковые имена позиций в одну строку', async () => {
    const { service } = buildService([
      item({ name: 'Стол', qty: '1', unitPrice: '1000', unitCostAtSale: '600' }),
      item({ name: 'Стол', qty: '1', unitPrice: '1000', unitCostAtSale: '600' }),
    ]);
    const r = await service.byProduct('ws1');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.revenue).toBe('2000.00');
    expect(r.rows[0]!.qty).toBe('2.000');
  });

  it('пустой набор → нулевые тоталы, маржа% = 0 при выручке 0', async () => {
    const { service } = buildService([]);
    const r = await service.byProduct('ws1');
    expect(r.rows).toHaveLength(0);
    expect(r.totals.revenue).toBe('0.00');
    expect(r.totals.marginPct).toBe('0.00');
  });

  it('фильтрует только DONE-заказы воркспейса (передаёт where в Prisma)', async () => {
    const { service, prisma } = buildService([]);
    await service.byProduct('wsX');
    const arg = prisma.orderItem.findMany.mock.calls[0]![0];
    expect(arg.where.deletedAt).toBeNull();
    expect(arg.where.order).toEqual({ workspaceId: 'wsX', status: 'DONE', deletedAt: null });
  });
});

describe('MarginService.byClient', () => {
  it('группирует по клиенту и подставляет имя контрагента', async () => {
    const { service } = buildService(
      [
        item({ name: 'Стол', qty: '1', unitPrice: '1000', unitCostAtSale: '600', clientId: 'c1' }),
        item({ name: 'Стул', qty: '2', unitPrice: '500', unitCostAtSale: '200', clientId: 'c1' }),
      ],
      [{ id: 'c1', name: 'ООО Ромашка' }],
    );
    const r = await service.byClient('ws1');
    expect(r.rows).toHaveLength(1);
    const row = r.rows[0]!;
    expect(row.key).toBe('c1');
    expect(row.name).toBe('ООО Ромашка');
    expect(row.revenue).toBe('2000.00'); // 1000 + 1000
    expect(row.cogs).toBe('1000.00'); // 600 + 400
    expect(row.margin).toBe('1000.00');
  });

  it('заказы без клиента группируются в «Без клиента» (key=null)', async () => {
    const { service } = buildService([
      item({ name: 'Стол', qty: '1', unitPrice: '1000', unitCostAtSale: '600', clientId: null }),
    ]);
    const r = await service.byClient('ws1');
    expect(r.rows[0]!.key).toBeNull();
    expect(r.rows[0]!.name).toBe('Без клиента');
  });
});
