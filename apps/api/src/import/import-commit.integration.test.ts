/**
 * Интеграционные тесты commit-импорта (Фаза 4 п.18): защита от повторного
 * импорта того же файла по fileHash. Реальная БД construct_v6_test.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { ConflictException } from '@nestjs/common';
import {
  buildHarness,
  resetDb,
  seedBase,
  type Harness,
  type Seed,
} from '../test/money-harness';
import { ImportService } from './import.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { CommitBody } from './import.dto';

let h: Harness;
let svc: ImportService;
let seed: Seed;
let tg = 800000n;

beforeAll(() => {
  h = buildHarness();
  svc = new ImportService(h.prisma as unknown as PrismaService);
});
afterAll(async () => {
  await h.prisma.$disconnect();
});
beforeEach(async () => {
  await resetDb(h.prisma);
  tg += 1n;
  seed = await seedBase(h.prisma, tg);
});

function body(over: Partial<CommitBody> = {}): CommitBody {
  return {
    filename: 'statement.csv',
    fileHash: 'FILE-1',
    source: 'GENERIC_CSV',
    accountId: seed.accountId,
    skipDuplicates: true,
    rows: [
      {
        date: '2026-05-01',
        amount: '100.00',
        type: 'EXPENSE',
        description: 'обед',
        counterpartyName: null,
        categoryId: null,
        importHash: 'row-1',
        isDuplicate: false,
      },
    ],
    ...over,
  };
}

describe('Import commit: дедуп по fileHash (Фаза 4 п.18)', () => {
  it('первый импорт файла проходит', async () => {
    const res = await svc.commit({ workspaceId: seed.workspaceId, userId: seed.userId, body: body() });
    expect(res.imported).toBe(1);
  });

  it('повторный импорт того же fileHash → 409, даже с другими строками', async () => {
    await svc.commit({ workspaceId: seed.workspaceId, userId: seed.userId, body: body() });
    await expect(
      svc.commit({
        workspaceId: seed.workspaceId,
        userId: seed.userId,
        body: body({
          rows: [
            {
              date: '2026-05-02',
              amount: '200.00',
              type: 'INCOME',
              description: 'другая строка',
              counterpartyName: null,
              categoryId: null,
              importHash: 'row-2',
              isDuplicate: false,
            },
          ],
        }),
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('после soft-delete прежнего батча тот же файл можно импортировать снова', async () => {
    const first = await svc.commit({ workspaceId: seed.workspaceId, userId: seed.userId, body: body() });
    await h.prisma.importBatch.update({
      where: { id: first.batchId },
      data: { deletedAt: new Date() },
    });
    // Другой importHash, чтобы не упереться в partial-unique п.17 (старые строки активны).
    const again = await svc.commit({
      workspaceId: seed.workspaceId,
      userId: seed.userId,
      body: body({
        rows: [
          {
            date: '2026-05-03',
            amount: '300.00',
            type: 'EXPENSE',
            description: 'повтор',
            counterpartyName: null,
            categoryId: null,
            importHash: 'row-3',
            isDuplicate: false,
          },
        ],
      }),
    });
    expect(again.imported).toBe(1);
  });
});

describe('Import commit: дедуп контрагентов по lowercase (M10)', () => {
  it('«Ромашка» и «РОМАШКА» из одного файла → один контрагент, общий id', async () => {
    const res = await svc.commit({
      workspaceId: seed.workspaceId,
      userId: seed.userId,
      body: body({
        rows: [
          {
            date: '2026-05-01',
            amount: '100.00',
            type: 'EXPENSE',
            description: 'оплата 1',
            counterpartyName: 'Ромашка',
            categoryId: null,
            importHash: 'cp-row-1',
            isDuplicate: false,
          },
          {
            date: '2026-05-02',
            amount: '200.00',
            type: 'EXPENSE',
            description: 'оплата 2',
            counterpartyName: 'РОМАШКА',
            categoryId: null,
            importHash: 'cp-row-2',
            isDuplicate: false,
          },
        ],
      }),
    });
    expect(res.imported).toBe(2);

    const cps = await h.prisma.counterparty.findMany({
      where: { workspaceId: seed.workspaceId, deletedAt: null },
      select: { id: true },
    });
    expect(cps).toHaveLength(1); // регистр-дубль НЕ создан

    const txs = await h.prisma.transaction.findMany({
      where: { workspaceId: seed.workspaceId, deletedAt: null },
      select: { counterpartyId: true },
    });
    expect(txs).toHaveLength(2);
    expect(txs[0]?.counterpartyId).toBe(cps[0]?.id);
    expect(txs[1]?.counterpartyId).toBe(cps[0]?.id); // обе ноги ссылаются на один id
  });

  it('переиспользует уже существующего контрагента независимо от регистра', async () => {
    const cp = await h.prisma.counterparty.create({
      data: { workspaceId: seed.workspaceId, name: 'Ромашка' },
    });
    const res = await svc.commit({
      workspaceId: seed.workspaceId,
      userId: seed.userId,
      body: body({
        rows: [
          {
            date: '2026-05-01',
            amount: '100.00',
            type: 'EXPENSE',
            description: 'оплата',
            counterpartyName: 'рОмАшКа',
            categoryId: null,
            importHash: 'cp-row-3',
            isDuplicate: false,
          },
        ],
      }),
    });
    expect(res.imported).toBe(1);
    const count = await h.prisma.counterparty.count({
      where: { workspaceId: seed.workspaceId, deletedAt: null },
    });
    expect(count).toBe(1); // нового не завели
    const tx = await h.prisma.transaction.findFirst({
      where: { workspaceId: seed.workspaceId, deletedAt: null },
      select: { counterpartyId: true },
    });
    expect(tx?.counterpartyId).toBe(cp.id);
  });
});

describe('annotateTransferSuggestions: границы дат без spread (M11)', () => {
  it('не роняет стек на десятках тысяч строк', async () => {
    const rows = Array.from({ length: 60000 }, (_, i) => ({
      rawIndex: i,
      date: new Date(Date.UTC(2026, 0, 1 + (i % 28))).toISOString(),
      amount: '100.00',
      type: 'EXPENSE' as const,
      description: null,
      counterpartyName: null,
      resolvedCounterpartyId: null,
      suggestedCategoryId: null,
      importHash: `h-${i}`,
      isDuplicate: false,
      transferSuggestion: null,
      errors: [],
      raw: {},
    }));
    // Раньше Math.min/max(...dates) на таком объёме давал RangeError (stack).
    await expect(
      (svc as unknown as {
        annotateTransferSuggestions: (w: string, a: string, r: typeof rows) => Promise<void>;
      }).annotateTransferSuggestions(seed.workspaceId, seed.accountId, rows),
    ).resolves.toBeUndefined();
  });
});
