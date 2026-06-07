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
