import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { WarehouseService } from './warehouse.service';
import { WarehouseRepository } from './warehouse.repository';

/**
 * Юнит-тесты сервисного слоя склада (Полоса B). PrismaService/UoW/Audit
 * мокаются плейн-объектами; репозиторий реальный, но его db() подменяется
 * на мок Prisma — БД не нужна.
 *
 * Покрытие:
 *   • B1: движения StockMovement пишутся с верными qtyDelta/qtyAfter/unitCost.
 *   • B4(а): adjust() сохраняет reason в ADJUSTMENT.
 *   • B4(б): supplierReturn двигает qty/avg, пишет движение + транзакцию.
 */

function makeItem(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'item1',
    workspaceId: 'ws1',
    name: 'Гвозди',
    unit: 'шт',
    qty: new Prisma.Decimal('10'),
    avgCost: new Prisma.Decimal('100'),
    reorderPoint: null,
    isArchived: false,
    deletedAt: null,
    ...over,
  };
}

/** Мок Prisma + реальный репозиторий поверх. */
function buildHarness(item = makeItem()) {
  const movements: Array<Record<string, unknown>> = [];
  const transactions: Array<Record<string, unknown>> = [];
  const itemState = { ...item };

  const prisma = {
    warehouseItem: {
      findFirst: vi.fn().mockImplementation(() => Promise.resolve({ ...itemState })),
      update: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
        Object.assign(itemState, data);
        return Promise.resolve({ ...itemState });
      }),
    },
    stockMovement: {
      create: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
        movements.push(data);
        return Promise.resolve({ id: `mv${movements.length}`, ...data });
      }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    transaction: {
      create: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
        transactions.push(data);
        return Promise.resolve({ id: `tx${transactions.length}`, ...data });
      }),
    },
    // tx с FOR UPDATE — возвращает строку, чтобы lockForUpdate нашёл её.
    $queryRaw: vi.fn().mockResolvedValue([{ id: itemState.id }]),
  };

  const repo = new WarehouseRepository(prisma as never);
  const uow = {
    run: vi.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const service = new WarehouseService(prisma as never, repo, uow as never, audit as never);

  return { service, prisma, movements, transactions, itemState };
}

describe('WarehouseService.applyPurchaseLine — движение PURCHASE (B1)', () => {
  it('пишет StockMovement(PURCHASE) с +qtyDelta, qtyAfter и unitCost', async () => {
    const h = buildHarness(makeItem({ qty: new Prisma.Decimal('10'), avgCost: new Prisma.Decimal('100') }));
    await h.service.applyPurchaseLine(h.prisma as never, 'ws1', 'item1', '5', '200', 'user1', {
      refType: 'Purchase',
      refId: 'p1',
    });
    expect(h.movements).toHaveLength(1);
    const mv = h.movements[0]!;
    expect(mv.type).toBe('PURCHASE');
    expect((mv.qtyDelta as Prisma.Decimal).toString()).toBe('5');
    expect((mv.qtyAfter as Prisma.Decimal).toString()).toBe('15');
    expect((mv.unitCost as Prisma.Decimal).toString()).toBe('200');
    expect(mv.refType).toBe('Purchase');
    expect(mv.refId).toBe('p1');
    expect(mv.createdById).toBe('user1');
  });
});

describe('WarehouseService.decrementForSale — движение SALE (B1)', () => {
  it('пишет StockMovement(SALE) с отрицательным qtyDelta и unitCost = avg', async () => {
    const h = buildHarness(makeItem({ qty: new Prisma.Decimal('10'), avgCost: new Prisma.Decimal('100') }));
    const unitCost = await h.service.decrementForSale(h.prisma as never, 'ws1', 'item1', '4', 'user1', {
      refType: 'Order',
      refId: 'o1',
    });
    expect(unitCost.toString()).toBe('100');
    expect(h.movements).toHaveLength(1);
    const mv = h.movements[0]!;
    expect(mv.type).toBe('SALE');
    expect((mv.qtyDelta as Prisma.Decimal).toString()).toBe('-4');
    expect((mv.qtyAfter as Prisma.Decimal).toString()).toBe('6');
    expect((mv.unitCost as Prisma.Decimal).toString()).toBe('100');
    expect(mv.refType).toBe('Order');
  });
});

describe('WarehouseService.restock — движение RETURN_CUSTOMER (B1)', () => {
  it('пишет StockMovement(RETURN_CUSTOMER) с +qtyDelta', async () => {
    const h = buildHarness(makeItem({ qty: new Prisma.Decimal('6'), avgCost: new Prisma.Decimal('100') }));
    await h.service.restock(h.prisma as never, 'ws1', 'item1', '2', 'user1', {
      refType: 'Order',
      refId: 'o1',
    });
    expect(h.movements).toHaveLength(1);
    const mv = h.movements[0]!;
    expect(mv.type).toBe('RETURN_CUSTOMER');
    expect((mv.qtyDelta as Prisma.Decimal).toString()).toBe('2');
    expect((mv.qtyAfter as Prisma.Decimal).toString()).toBe('8');
  });
});

describe('WarehouseService.adjust — ADJUSTMENT с reason (B4а)', () => {
  it('сохраняет reason и пишет движение с qtyDelta = newQty - oldQty', async () => {
    const h = buildHarness(makeItem({ qty: new Prisma.Decimal('10') }));
    await h.service.adjust('ws1', 'item1', { newQty: '7', reason: 'недостача' }, 'user1');
    expect(h.movements).toHaveLength(1);
    const mv = h.movements[0]!;
    expect(mv.type).toBe('ADJUSTMENT');
    expect((mv.qtyDelta as Prisma.Decimal).toString()).toBe('-3');
    expect((mv.qtyAfter as Prisma.Decimal).toString()).toBe('7');
    expect(mv.reason).toBe('недостача');
    expect((h.itemState.qty as Prisma.Decimal).toString()).toBe('7');
  });

  it('не пишет движение, если qty не изменилось', async () => {
    const h = buildHarness(makeItem({ qty: new Prisma.Decimal('10') }));
    await h.service.adjust('ws1', 'item1', { newQty: '10' }, 'user1');
    expect(h.movements).toHaveLength(0);
  });
});

describe('WarehouseService.supplierReturn — возврат поставщику (B4б)', () => {
  it('двигает qty/avg, пишет RETURN_SUPPLIER + транзакцию-уменьшение расхода', async () => {
    // 20 @ 150 (value 3000), вернули 3, refund 600 → 17 @ 141.1765
    const h = buildHarness(makeItem({ qty: new Prisma.Decimal('20'), avgCost: new Prisma.Decimal('150') }));
    await h.service.supplierReturn('ws1', 'item1', 'user1', {
      returnQty: '3',
      refundAmount: '600',
      accountId: 'acc1',
    });

    expect((h.itemState.qty as Prisma.Decimal).toString()).toBe('17');
    expect((h.itemState.avgCost as Prisma.Decimal).toFixed(2)).toBe('141.18');

    expect(h.movements).toHaveLength(1);
    const mv = h.movements[0]!;
    expect(mv.type).toBe('RETURN_SUPPLIER');
    expect((mv.qtyDelta as Prisma.Decimal).toString()).toBe('-3');
    expect((mv.qtyAfter as Prisma.Decimal).toString()).toBe('17');

    expect(h.transactions).toHaveLength(1);
    const tx = h.transactions[0]!;
    // Возврат поставщику = приход денег на счёт (refund) → INCOME, уменьшает расход.
    expect(tx.type).toBe('INCOME');
    expect((tx.amount as Prisma.Decimal).toFixed(2)).toBe('600.00');
    expect(tx.accountId).toBe('acc1');
  });

  it('бросает при попытке вернуть больше, чем есть на складе', async () => {
    const h = buildHarness(makeItem({ qty: new Prisma.Decimal('2') }));
    await expect(
      h.service.supplierReturn('ws1', 'item1', 'user1', {
        returnQty: '5',
        refundAmount: '100',
        accountId: 'acc1',
      }),
    ).rejects.toThrow();
    expect(h.movements).toHaveLength(0);
    expect(h.transactions).toHaveLength(0);
  });
});

describe('WarehouseService.lowStock (B3)', () => {
  it('делегирует в repo.lowStock с workspaceId', async () => {
    const h = buildHarness();
    const rows = [{ id: 'a', name: 'X', qty: new Prisma.Decimal('1') }];
    (h.prisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValueOnce(rows);
    const res = await h.service.lowStock('ws1');
    expect(res).toBe(rows);
  });
});

describe('WarehouseService import (B2)', () => {
  /** Подменяем findByNames на список «уже существующих» имён. */
  function importHarness(existingNames: string[] = []) {
    const created: Array<Record<string, unknown>> = [];
    const movements: Array<Record<string, unknown>> = [];
    const prisma = {
      warehouseItem: {
        findMany: vi.fn().mockResolvedValue(
          existingNames.map((name, i) => ({ id: `e${i}`, name })),
        ),
        create: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return Promise.resolve({ id: `c${created.length}`, ...data });
        }),
      },
      stockMovement: {
        create: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
          movements.push(data);
          return Promise.resolve({ id: `m${movements.length}`, ...data });
        }),
      },
    };
    const repo = new WarehouseRepository(prisma as never);
    const uow = {
      run: vi.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
    };
    const service = new WarehouseService(prisma as never, repo, uow as never, { record: vi.fn() } as never);
    return { service, created, movements };
  }

  it('commit создаёт позицию + OPENING-движение, без транзакции', async () => {
    const h = importHarness([]);
    const res = await h.service.importCommit('ws1', 'user1', [
      { name: 'Болты', qty: '50', avgCost: '10', unit: 'шт', reorderPoint: '5' },
    ]);
    expect(res).toEqual({ created: 1, skipped: 0 });
    expect(h.created).toHaveLength(1);
    expect((h.created[0]!.qty as Prisma.Decimal).toString()).toBe('50');
    expect(h.movements).toHaveLength(1);
    expect(h.movements[0]!.type).toBe('OPENING');
    expect((h.movements[0]!.qtyAfter as Prisma.Decimal).toString()).toBe('50');
  });

  it('повторный импорт того же имени НЕ двоит (skip по существующему)', async () => {
    const h = importHarness(['Болты']);
    const res = await h.service.importCommit('ws1', 'user1', [
      { name: 'Болты', qty: '50', avgCost: '10' },
    ]);
    expect(res).toEqual({ created: 0, skipped: 1 });
    expect(h.created).toHaveLength(0);
    expect(h.movements).toHaveLength(0);
  });

  it('дубль имени ВНУТРИ одного файла создаётся один раз', async () => {
    const h = importHarness([]);
    const res = await h.service.importCommit('ws1', 'user1', [
      { name: 'Гайки', qty: '10' },
      { name: 'гайки', qty: '99' },
    ]);
    expect(res).toEqual({ created: 1, skipped: 1 });
    expect(h.created).toHaveLength(1);
  });
});
