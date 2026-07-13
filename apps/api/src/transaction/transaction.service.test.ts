import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Prisma, TransactionKind, type CategoryBucket } from '@prisma/client';
import { TransactionService, KINDS_FOR_BUCKET, TRANSFER_KINDS } from './transaction.service';
import { bucketForSystemKind } from '../reports/pnl.service';

/**
 * Юнит-тесты сервисного слоя транзакций (Фаза 3 п.16): блокировка системных
 * транзакций и запись аудита при update. PrismaService и AuditService мокаются
 * плейн-объектами — БД не нужна.
 */

function makeTx(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'tx1',
    workspaceId: 'ws1',
    date: new Date('2026-05-01T00:00:00.000Z'),
    amount: new Prisma.Decimal('100.00'),
    type: 'EXPENSE',
    kind: 'OTHER',
    accountId: 'acc1',
    categoryId: null,
    counterpartyId: null,
    description: 'старое',
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-01T00:00:00.000Z'),
    ...over,
  };
}

function buildService(existing: ReturnType<typeof makeTx>) {
  const prisma = {
    transaction: {
      findFirst: vi.fn().mockResolvedValue(existing),
      update: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
        // Prisma игнорирует undefined-поля — повторяем это в моке, иначе
        // `...data` затрёт существующие значения (date/amount) на undefined.
        const defined = Object.fromEntries(
          Object.entries(data).filter(([, v]) => v !== undefined),
        );
        return Promise.resolve(makeTx({ ...existing, ...defined }));
      }),
    },
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const service = new TransactionService(prisma as never, audit as never);
  return { service, prisma, audit };
}

describe('TransactionService.update — блокировка системных (п.16)', () => {
  it.each(['ORDER_PAYMENT', 'ORDER_REFUND', 'COGS', 'PURCHASE'] as const)(
    'отказывает в правке системной транзакции %s',
    async (kind) => {
      const { service, prisma, audit } = buildService(makeTx({ kind }));
      await expect(
        service.update('ws1', 'tx1', { description: 'хочу поменять' }, 'user1'),
      ).rejects.toThrow();
      expect(prisma.transaction.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    },
  );

  it('разрешает правку ручной транзакции и пишет аудит с diff', async () => {
    const { service, prisma, audit } = buildService(makeTx({ kind: 'OTHER' }));
    await service.update('ws1', 'tx1', { description: 'новое' }, 'user1');

    expect(prisma.transaction.update).toHaveBeenCalledOnce();
    expect(audit.record).toHaveBeenCalledOnce();
    const entry = audit.record.mock.calls[0]![1] as any;
    expect(entry.action).toBe('transaction.update');
    expect(entry.actorId).toBe('user1');
    expect((entry.diff as any).before.description).toBe('старое');
    expect((entry.diff as any).changes.description).toBe('новое');
  });

  it('отвергает несовместимый kind↔type (CAPITAL_IN при EXPENSE)', async () => {
    const { service, prisma } = buildService(makeTx({ type: 'EXPENSE', kind: 'OTHER' }));
    await expect(
      service.update('ws1', 'tx1', { kind: 'CAPITAL_IN' }, 'user1'),
    ).rejects.toThrow();
    expect(prisma.transaction.update).not.toHaveBeenCalled();
  });

  it('отвергает смену type, делающую текущий kind несовместимым', async () => {
    // existing kind=CAPITAL_IN (INCOME); меняем type на EXPENSE без нового kind.
    const { service, prisma } = buildService(makeTx({ type: 'INCOME', kind: 'CAPITAL_IN' }));
    await expect(
      service.update('ws1', 'tx1', { type: 'EXPENSE' }, 'user1'),
    ).rejects.toThrow();
    expect(prisma.transaction.update).not.toHaveBeenCalled();
  });
});

describe('TransactionService.summary — исключение ног переводов (Трек A, A1)', () => {
  interface FakeTx {
    type: 'INCOME' | 'EXPENSE';
    kind: string;
    amount: string;
  }

  function buildSummaryService(rows: FakeTx[]) {
    const groupByCalls: Array<Record<string, unknown>> = [];
    const prisma = {
      transaction: {
        groupBy: vi.fn().mockImplementation((args: { where: Record<string, unknown> }) => {
          groupByCalls.push(args.where);
          const notIn = (args.where.kind as { notIn?: string[] } | undefined)?.notIn ?? [];
          const filtered = rows.filter((r) => !notIn.includes(r.kind));
          const acc = new Map<string, Prisma.Decimal>();
          for (const r of filtered) {
            acc.set(r.type, (acc.get(r.type) ?? new Prisma.Decimal(0)).plus(r.amount));
          }
          return Promise.resolve(
            [...acc.entries()].map(([type, sum]) => ({ type, _sum: { amount: sum } })),
          );
        }),
      },
    };
    const audit = { record: vi.fn() };
    return { service: new TransactionService(prisma as never, audit as never), groupByCalls };
  }

  it('where исключает ноги переводов И неденежный COGS (R2)', async () => {
    const { service, groupByCalls } = buildSummaryService([]);
    await service.summary('ws1', {} as never);
    expect((groupByCalls[0]!.kind as { notIn: string[] }).notIn).toEqual([
      'TRANSFER_IN',
      'TRANSFER_OUT',
      'COGS',
      'WRITE_OFF', // F4: списание — тоже неденежный (R2)
    ]);
  });

  it('перевод и COGS НЕ раздувают income/expense дашборда (R2)', async () => {
    // Перевод 500 (обе ноги) + неденежный COGS 300 + реальная выручка 1000.
    const { service } = buildSummaryService([
      { type: 'INCOME', kind: 'ORDER_PAYMENT', amount: '1000.00' },
      { type: 'EXPENSE', kind: 'TRANSFER_OUT', amount: '500.00' },
      { type: 'INCOME', kind: 'TRANSFER_IN', amount: '500.00' },
      { type: 'EXPENSE', kind: 'COGS', amount: '300.00' },
    ]);
    const res = await service.summary('ws1', {} as never);
    expect(res.income).toBe('1000.00'); // TRANSFER_IN исключён
    expect(res.expense).toBe('0.00'); // TRANSFER_OUT и COGS исключены (не деньги)
    expect(res.net).toBe('1000.00');
  });

  it('M8: from/to нормализуются к границам суток в UTC+5 (как cashflow/pnl)', async () => {
    const { service, groupByCalls } = buildSummaryService([]);
    await service.summary('ws1', { from: '2026-05-15', to: '2026-05-15' } as never);
    const date = groupByCalls[0]!.date as { gte: Date; lte: Date };
    // from → начало суток 15 мая в UTC+5 = 14 мая 19:00 UTC.
    expect(date.gte.toISOString()).toBe('2026-05-14T19:00:00.000Z');
    // to → конец суток 15 мая в UTC+5 = 15 мая 18:59:59.999 UTC (inclusive lte),
    // а НЕ сырой 2026-05-15T00:00:00Z, который резал бы весь день.
    expect(date.lte.toISOString()).toBe('2026-05-15T18:59:59.999Z');
  });
});

describe('TransactionService.softDelete — блокировка системных (п.16)', () => {
  it('отказывает в удалении системной транзакции', async () => {
    const { service, prisma, audit } = buildService(makeTx({ kind: 'ORDER_PAYMENT' }));
    await expect(service.softDelete('ws1', 'tx1', 'user1')).rejects.toThrow();
    expect(prisma.transaction.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('удаляет ручную транзакцию и пишет аудит transaction.delete', async () => {
    const { service, prisma, audit } = buildService(makeTx({ kind: 'SALARY', type: 'EXPENSE' }));
    await service.softDelete('ws1', 'tx1', 'user1');
    expect(prisma.transaction.update).toHaveBeenCalledOnce();
    expect((audit.record.mock.calls[0]![1] as any).action).toBe('transaction.delete');
  });
});

describe('KINDS_FOR_BUCKET — синхронизация с bucketForSystemKind (drill-down ОПиУ)', () => {
  it('каждый не-transfer kind лежит ровно в одном бакете, и это бакет bucketForSystemKind', () => {
    const allKinds = Object.values(TransactionKind);
    for (const kind of allKinds) {
      const containing = (Object.keys(KINDS_FOR_BUCKET) as CategoryBucket[]).filter((b) =>
        KINDS_FOR_BUCKET[b].includes(kind),
      );
      if (TRANSFER_KINDS.includes(kind)) {
        // Переводы в ОПиУ не входят — их нет ни в одном бакете.
        expect(containing, `transfer kind ${kind} не должен быть в карте`).toHaveLength(0);
      } else {
        expect(containing, `kind ${kind} должен быть ровно в одном бакете`).toHaveLength(1);
        expect(containing[0], `kind ${kind}: карта разошлась с pnl.service`).toBe(
          bucketForSystemKind(kind),
        );
      }
    }
  });
});
