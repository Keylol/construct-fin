import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { ReconciliationService } from './reconciliation.service';

/**
 * Юнит-тесты сверки (Полоса D). Prisma мокается plain-object; groupBy/findMany
 * эмулируют фильтр по date (lte/gt) и accountId. Проверяем: расчётный остаток,
 * расхождение книги с фактом на дату снимка, список несведённых операций.
 */

interface FakeTx {
  type: 'INCOME' | 'EXPENSE';
  amount: string;
  date: Date;
  kind?: string;
  id?: string;
  description?: string | null;
}

interface FakeCheck {
  id: string;
  accountId: string;
  date: Date;
  actualBalance: string;
  note: string | null;
  createdAt: Date;
  workspaceId?: string;
}

const ACCOUNT = { id: 'acc1', name: 'Касса', openingBalance: new Prisma.Decimal('1000.00') };

function buildService(opts: {
  account?: { id: string; name: string; openingBalance: Prisma.Decimal } | null;
  txs?: FakeTx[];
  checks?: FakeCheck[];
} = {}) {
  const account = opts.account === undefined ? ACCOUNT : opts.account;
  const txs = (opts.txs ?? []).map((t, i) => ({
    id: t.id ?? `tx${i}`,
    type: t.type,
    amount: new Prisma.Decimal(t.amount),
    date: t.date,
    kind: t.kind ?? 'OTHER',
    description: t.description ?? null,
  }));
  const checks = opts.checks ?? [];
  const created: Array<{ data: Record<string, unknown> }> = [];
  const deleted: string[] = [];

  const prisma = {
    account: {
      findFirst: vi.fn().mockImplementation(({ where }: { where: { id: string } }) =>
        Promise.resolve(account && account.id === where.id ? account : null),
      ),
    },
    accountBalanceCheck: {
      create: vi.fn().mockImplementation((arg: { data: Record<string, unknown> }) => {
        created.push(arg);
        return Promise.resolve({
          id: 'chkNew',
          accountId: arg.data.accountId,
          date: arg.data.date,
          actualBalance: arg.data.actualBalance,
          note: arg.data.note,
          createdAt: new Date('2026-06-01T00:00:00.000Z'),
        });
      }),
      findMany: vi.fn().mockResolvedValue(checks),
      findFirst: vi.fn().mockImplementation(
        ({ where }: { where: { id?: string; workspaceId?: string; date?: { lte?: Date } } }) => {
          const lte = where.date?.lte;
          const eligible = checks
            .filter((c) => !lte || c.date.getTime() <= lte.getTime())
            .filter((c) => !where.id || c.id === where.id)
            .filter((c) => !where.workspaceId || (c.workspaceId ?? 'ws1') === where.workspaceId)
            .sort((a, b) => b.date.getTime() - a.date.getTime());
          return Promise.resolve(eligible[0] ?? null);
        },
      ),
      delete: vi.fn().mockImplementation(({ where }: { where: { id: string } }) => {
        deleted.push(where.id);
        return Promise.resolve(undefined);
      }),
    },
    transaction: {
      groupBy: vi.fn().mockImplementation((args: { where: { date?: { lte?: Date } } }) => {
        const lte = args.where.date?.lte;
        const filtered = txs.filter((t) => !lte || t.date.getTime() <= lte.getTime());
        const sums = new Map<string, Prisma.Decimal>();
        for (const t of filtered) {
          sums.set(t.type, (sums.get(t.type) ?? new Prisma.Decimal(0)).plus(t.amount));
        }
        return Promise.resolve(
          [...sums.entries()].map(([type, amount]) => ({ type, _sum: { amount } })),
        );
      }),
      findMany: vi.fn().mockImplementation((args: { where: { date?: { gt?: Date; lte?: Date } } }) => {
        const gt = args.where.date?.gt;
        const lte = args.where.date?.lte;
        const filtered = txs.filter(
          (t) =>
            (!gt || t.date.getTime() > gt.getTime()) &&
            (!lte || t.date.getTime() <= lte.getTime()),
        );
        return Promise.resolve(filtered);
      }),
    },
  };

  const service = new ReconciliationService(prisma as never, { anchorFromCheck: async () => null } as never);
  return { service, prisma, created, deleted };
}

describe('ReconciliationService.createCheck', () => {
  it('создаёт снимок с округлением до 2 знаков и сериализует', async () => {
    const { service, created } = buildService();
    const out = await service.createCheck('ws1', 'user1', {
      accountId: 'acc1',
      date: '2026-06-10T00:00:00.000Z',
      actualBalance: '1234.5',
      note: 'выписка',
    });
    expect(created).toHaveLength(1);
    expect((created[0]!.data.actualBalance as Prisma.Decimal).toFixed(2)).toBe('1234.50');
    expect(created[0]!.data.note).toBe('выписка');
    expect(out.actualBalance).toBe('1234.50');
  });

  it('бросает NotFound для чужого/несуществующего счёта', async () => {
    const { service } = buildService({ account: null });
    await expect(
      service.createCheck('ws1', 'user1', {
        accountId: 'nope',
        date: '2026-06-10T00:00:00.000Z',
        actualBalance: '100.00',
      }),
    ).rejects.toThrow();
  });
});

describe('ReconciliationService.build', () => {
  const D1 = new Date('2026-06-05T00:00:00.000Z');
  const D2 = new Date('2026-06-12T00:00:00.000Z');
  const ASOF = '2026-06-15T00:00:00.000Z';

  it('без снимков: расчётный остаток и все операции до asOf', async () => {
    const { service } = buildService({
      txs: [
        { type: 'INCOME', amount: '500.00', date: D1 },
        { type: 'EXPENSE', amount: '200.00', date: D2 },
      ],
    });
    const r = await service.build('ws1', 'acc1', ASOF);
    // 1000 + 500 - 200 = 1300
    expect(r.computedBalance).toBe('1300.00');
    expect(r.openingBalance).toBe('1000.00');
    expect(r.lastCheck).toBeNull();
    expect(r.unreconciled.since).toBeNull();
    expect(r.unreconciled.count).toBe(2);
    // net несведённых = +500 - 200 = +300
    expect(r.unreconciled.net).toBe('300.00');
  });

  it('со снимком: расхождение книги с фактом и несведённые операции ПОСЛЕ снимка', async () => {
    const { service } = buildService({
      txs: [
        { type: 'INCOME', amount: '500.00', date: D1 }, // до снимка
        { type: 'EXPENSE', amount: '200.00', date: D2 }, // после снимка
      ],
      checks: [
        // факт на 2026-06-08: книга на эту дату = 1000 + 500 = 1500
        {
          id: 'chk1',
          accountId: 'acc1',
          date: new Date('2026-06-08T00:00:00.000Z'),
          actualBalance: '1450.00',
          note: null,
          createdAt: new Date('2026-06-08T00:00:00.000Z'),
        },
      ],
    });
    const r = await service.build('ws1', 'acc1', ASOF);
    expect(r.computedBalance).toBe('1300.00'); // на asOf
    expect(r.lastCheck).not.toBeNull();
    expect(r.lastCheck!.computedBalance).toBe('1500.00'); // книга на дату снимка
    expect(r.lastCheck!.actualBalance).toBe('1450.00');
    // discrepancy = факт − книга = 1450 - 1500 = -50 (книга завышена)
    expect(r.lastCheck!.discrepancy).toBe('-50.00');
    // несведённые — только операция после снимка (EXPENSE 200). Граница since —
    // КОНЕЦ суток снимка в UTC+5 (M3): 2026-06-08 23:59:59.999 UTC+5 = 18:59:59.999 UTC.
    expect(r.unreconciled.since).toBe('2026-06-08T18:59:59.999Z');
    expect(r.unreconciled.count).toBe(1);
    expect(r.unreconciled.net).toBe('-200.00');
  });

  it('M3: asOf date-only включает операции до конца суток в UTC+5', async () => {
    // Операция в 23:30 по UTC+5 (2026-06-15) = 2026-06-15T18:30:00Z. asOf — date-only.
    // Сырой new Date('2026-06-15') = 00:00 UTC отрезал бы её (computedBalance занижен).
    const lateTx = new Date('2026-06-15T18:30:00.000Z');
    const { service } = buildService({
      txs: [{ type: 'INCOME', amount: '300.00', date: lateTx }],
    });
    const r = await service.build('ws1', 'acc1', '2026-06-15');
    expect(r.computedBalance).toBe('1300.00'); // 1000 + 300, операция НЕ выпала
    expect(r.unreconciled.count).toBe(1);
    expect(r.unreconciled.net).toBe('300.00');
  });

  it('M3: книга на дату снимка учитывает операции дня снимка (UTC+5)', async () => {
    // Снимок 2026-06-08; операция в 22:00 по UTC+5 того же дня = 2026-06-08T17:00:00Z.
    // Старый код (lastCheck.date 00:00 UTC) исключил бы её → ложное расхождение.
    const sameDayLate = new Date('2026-06-08T17:00:00.000Z');
    const { service } = buildService({
      txs: [{ type: 'INCOME', amount: '200.00', date: sameDayLate }],
      checks: [
        {
          id: 'chk1',
          accountId: 'acc1',
          date: new Date('2026-06-08T00:00:00.000Z'),
          actualBalance: '1200.00',
          note: null,
          createdAt: new Date('2026-06-08T00:00:00.000Z'),
        },
      ],
    });
    const r = await service.build('ws1', 'acc1', '2026-06-15');
    // книга на конец 2026-06-08 = 1000 + 200 = 1200, расхождение с фактом 1200 = 0.
    expect(r.lastCheck!.computedBalance).toBe('1200.00');
    expect(r.lastCheck!.discrepancy).toBe('0.00');
    // операция входит в день снимка → НЕ числится несведённой.
    expect(r.unreconciled.count).toBe(0);
  });
});

describe('ReconciliationService.deleteCheck', () => {
  it('удаляет существующий снимок', async () => {
    const { service, deleted } = buildService({
      checks: [
        {
          id: 'chk1',
          accountId: 'acc1',
          date: new Date('2026-06-08T00:00:00.000Z'),
          actualBalance: '100.00',
          note: null,
          createdAt: new Date('2026-06-08T00:00:00.000Z'),
        },
      ],
    });
    // findFirst для delete ищет по id+workspaceId без date — вернёт первый из checks
    await service.deleteCheck('ws1', 'chk1');
    expect(deleted).toEqual(['chk1']);
  });

  it('бросает NotFound, если снимка нет', async () => {
    const { service } = buildService({ checks: [] });
    await expect(service.deleteCheck('ws1', 'missing')).rejects.toThrow();
  });

  it('изоляция: не удаляет снимок чужого workspace', async () => {
    const { service, deleted } = buildService({
      checks: [
        {
          id: 'chk1',
          accountId: 'acc1',
          workspaceId: 'ws1',
          date: new Date('2026-06-08T00:00:00.000Z'),
          actualBalance: '100.00',
          note: null,
          createdAt: new Date('2026-06-08T00:00:00.000Z'),
        },
      ],
    });
    await expect(service.deleteCheck('ws2', 'chk1')).rejects.toThrow();
    expect(deleted).toEqual([]);
  });
});
