import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { PnlService } from './pnl.service';

/**
 * Юнит-тесты P&L (Полоса A, шаг A3): ноги переводов исключаются ПО kind
 * (TRANSFER_IN/OUT) и НЕ участвуют в доходах/расходах; комиссия перевода
 * (kind=VARIABLE_COST, хоть и с transferGroupId) ОСТАЁТСЯ расходом.
 */

interface FakeTx {
  type: 'INCOME' | 'EXPENSE';
  kind: string;
  categoryId: string | null;
  transferGroupId: string | null;
  amount: string;
}

function buildService(rows: FakeTx[]) {
  const groupByCalls: Array<Record<string, unknown>> = [];
  const prisma = {
    category: {
      findMany: vi.fn().mockResolvedValue([
        { id: 'cat-rev', name: 'Выручка', bucket: 'REVENUE' },
        { id: 'cat-var', name: 'Комиссии', bucket: 'VARIABLE' },
      ]),
    },
    transaction: {
      groupBy: vi.fn().mockImplementation((args: { where: Record<string, unknown> }) => {
        groupByCalls.push(args.where);
        // эмулируем фильтр Prisma: kind notIn [...] (ноги исключаются по kind)
        const where = args.where as {
          kind?: { notIn: string[] };
        };
        const notIn = where.kind?.notIn ?? [];
        const filtered = rows.filter((r) => !notIn.includes(r.kind));
        // groupBy by [type, categoryId, kind]
        const acc = new Map<string, { type: string; categoryId: string | null; kind: string; sum: Prisma.Decimal }>();
        for (const r of filtered) {
          const key = `${r.type}|${r.categoryId}|${r.kind}`;
          const cur = acc.get(key) ?? {
            type: r.type,
            categoryId: r.categoryId,
            kind: r.kind,
            sum: new Prisma.Decimal(0),
          };
          cur.sum = cur.sum.plus(r.amount);
          acc.set(key, cur);
        }
        return Promise.resolve(
          [...acc.values()].map((v) => ({
            type: v.type,
            categoryId: v.categoryId,
            kind: v.kind,
            _sum: { amount: v.sum },
          })),
        );
      }),
    },
  };
  const service = new PnlService(prisma as never);
  return { service, prisma, groupByCalls };
}

// Середина месяца в локальном времени, чтобы enumerateMonths (использует
// getMonth() в локальной TZ) дал ровно один слайс независимо от часового пояса.
const PERIOD = {
  from: new Date(2026, 5, 5, 12, 0, 0),
  to: new Date(2026, 5, 25, 12, 0, 0),
};

describe('PnlService — исключение ног переводов (A3)', () => {
  it('where фильтрует kind notIn TRANSFER_IN/OUT (не по transferGroupId)', async () => {
    const { service, groupByCalls } = buildService([]);
    await service.build({ workspaceId: 'ws1', primary: PERIOD, comparison: null, groupBy: 'month' });
    expect(groupByCalls.length).toBeGreaterThan(0);
    for (const where of groupByCalls) {
      expect((where.kind as { notIn: string[] }).notIn).toEqual(['TRANSFER_IN', 'TRANSFER_OUT']);
      // транзит больше НЕ фильтруется по transferGroupId — иначе комиссия выпадет
      expect(where.transferGroupId).toBeUndefined();
    }
  });

  it('ноги перевода НЕ двигают P&L, а комиссия — двигает', async () => {
    const rows: FakeTx[] = [
      // реальная выручка
      { type: 'INCOME', kind: 'OTHER', categoryId: 'cat-rev', transferGroupId: null, amount: '1000.00' },
      // ноги перевода — должны быть исключены
      { type: 'EXPENSE', kind: 'TRANSFER_OUT', categoryId: null, transferGroupId: 'tr1', amount: '500.00' },
      { type: 'INCOME', kind: 'TRANSFER_IN', categoryId: null, transferGroupId: 'tr1', amount: '500.00' },
      // комиссия перевода — реальный расход, остаётся (теперь с transferGroupId,
      // но фильтр по kind её НЕ исключает)
      { type: 'EXPENSE', kind: 'VARIABLE_COST', categoryId: 'cat-var', transferGroupId: 'tr1', amount: '15.00' },
    ];
    const { service } = buildService(rows);
    const report = await service.build({
      workspaceId: 'ws1',
      primary: PERIOD,
      comparison: null,
      groupBy: 'month',
    });
    const totals = report.primary.totals;
    expect(totals.income).toBe('1000.00'); // TRANSFER_IN не вошёл
    expect(totals.expense).toBe('15.00'); // только комиссия, без TRANSFER_OUT
    expect(totals.net).toBe('985.00'); // 1000 - 15
  });

  it('системные операции без категории бакетятся по kind, не утекают в OTHER (A3)', async () => {
    const rows: FakeTx[] = [
      // выручка заказа — без категории, должна попасть в REVENUE (раньше → OTHER)
      { type: 'INCOME', kind: 'ORDER_PAYMENT', categoryId: null, transferGroupId: null, amount: '1000.00' },
      // вложение собственника — в CAPITAL и ВНЕ операционного net (раньше → OTHER
      // и ошибочно завышало прибыль)
      { type: 'INCOME', kind: 'CAPITAL_IN', categoryId: null, transferGroupId: null, amount: '5000.00' },
      // себестоимость — в COGS
      { type: 'EXPENSE', kind: 'COGS', categoryId: null, transferGroupId: null, amount: '400.00' },
    ];
    const { service } = buildService(rows);
    const report = await service.build({
      workspaceId: 'ws1',
      primary: PERIOD,
      comparison: null,
      groupBy: 'month',
    });
    const totals = report.primary.totals;
    const bucket = (b: string) => totals.byBucket.find((x) => x.bucket === b)!;
    expect(bucket('REVENUE').income).toBe('1000.00');
    expect(bucket('CAPITAL').income).toBe('5000.00');
    expect(bucket('COGS').expense).toBe('400.00');
    expect(bucket('OTHER').income).toBe('0.00'); // ничего не утекло в OTHER
    expect(bucket('OTHER').expense).toBe('0.00');
    // headline income включает капитал (6000), но операционный net его исключает:
    // (1000 опер.дохода) − (400 COGS) = 600. До фикса CAPITAL_IN тёк в OTHER → net=5600.
    expect(totals.income).toBe('6000.00');
    expect(totals.net).toBe('600.00');
    expect(totals.cogs).toBe('400.00');
    expect(totals.grossProfit).toBe('600.00');
  });

  it('PURCHASE → PURCHASES; SUPPLIER_REFUND гасит закупки; grossProfit без закупок (A6)', async () => {
    const rows: FakeTx[] = [
      { type: 'INCOME', kind: 'ORDER_PAYMENT', categoryId: null, transferGroupId: null, amount: '2000.00' },
      { type: 'EXPENSE', kind: 'COGS', categoryId: null, transferGroupId: null, amount: '500.00' },
      // закупка склада → отдельный бакет PURCHASES (не COGS, не OTHER)
      { type: 'EXPENSE', kind: 'PURCHASE', categoryId: null, transferGroupId: null, amount: '800.00' },
      // возврат поставщику (type=INCOME) → PURCHASES.income, гасит закупку
      { type: 'INCOME', kind: 'SUPPLIER_REFUND', categoryId: null, transferGroupId: null, amount: '100.00' },
    ];
    const { service } = buildService(rows);
    const report = await service.build({
      workspaceId: 'ws1',
      primary: PERIOD,
      comparison: null,
      groupBy: 'month',
    });
    const totals = report.primary.totals;
    const bucket = (b: string) => totals.byBucket.find((x) => x.bucket === b)!;
    expect(bucket('PURCHASES').expense).toBe('800.00');
    expect(bucket('PURCHASES').income).toBe('100.00'); // чистые закупки = 700
    expect(bucket('REVENUE').income).toBe('2000.00');
    expect(bucket('COGS').expense).toBe('500.00');
    expect(bucket('OTHER').income).toBe('0.00');
    expect(bucket('OTHER').expense).toBe('0.00');
    // grossProfit НЕ включает закупки: = operatingIncome(2100) − cogs(500) = 1600
    expect(totals.cogs).toBe('500.00');
    expect(totals.grossProfit).toBe('1600.00');
    // net операционный = доход 2100 − расход 1300 = 800 (закупки входят в net)
    expect(totals.net).toBe('800.00');
  });

  it('перевод без прочих операций даёт нулевой P&L', async () => {
    const rows: FakeTx[] = [
      { type: 'EXPENSE', kind: 'TRANSFER_OUT', categoryId: null, transferGroupId: 'tr1', amount: '500.00' },
      { type: 'INCOME', kind: 'TRANSFER_IN', categoryId: null, transferGroupId: 'tr1', amount: '500.00' },
    ];
    const { service } = buildService(rows);
    const report = await service.build({
      workspaceId: 'ws1',
      primary: PERIOD,
      comparison: null,
      groupBy: 'month',
    });
    expect(report.primary.totals.income).toBe('0.00');
    expect(report.primary.totals.expense).toBe('0.00');
    expect(report.primary.totals.net).toBe('0.00');
  });
});
