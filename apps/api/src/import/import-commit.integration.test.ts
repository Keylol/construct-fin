/**
 * Интеграционные тесты commit-импорта. Реальная БД construct_v6_test.
 *
 * Импорт файла кладёт выписку во «Входящие», а не создаёт операции: счёт вроде
 * карты ВБ банк по API не отдаёт, и раньше такая выписка выпадала из общего
 * конвейера (правила, детектор переводов, привязка к заказу). Поэтому проверяем
 * именно строки, а разметку — там, где она теперь живёт: в inbox-тестах.
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
  svc = new ImportService(h.prisma as unknown as PrismaService, h.orders, h.audit);
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
        importHash: 'row-1',
        isDuplicate: false,
      },
    ],
    ...over,
  };
}

describe('Import commit: выписка попадает во «Входящие»', () => {
  it('строки заводятся на разбор, операций не создаётся', async () => {
    const res = await svc.commit({
      workspaceId: seed.workspaceId,
      userId: seed.userId,
      body: body(),
    });
    expect(res.imported).toBe(1);

    const lines = await h.prisma.bankStatementLine.findMany({
      where: { workspaceId: seed.workspaceId },
      select: {
        status: true,
        direction: true,
        amount: true,
        externalId: true,
        importBatchId: true,
        description: true,
      },
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.status).toBe('NEW');
    expect(lines[0]?.direction).toBe('EXPENSE');
    expect(lines[0]?.amount.toFixed(2)).toBe('100.00');
    // externalId = importHash: тот же отпечаток, по которому превью метит дубли.
    expect(lines[0]?.externalId).toBe('row-1');
    expect(lines[0]?.importBatchId).toBe(res.batchId);

    // Денег импорт больше не двигает — это делает разбор строки.
    const txCount = await h.prisma.transaction.count({
      where: { workspaceId: seed.workspaceId, deletedAt: null },
    });
    expect(txCount).toBe(0);
  });

  it('строки ложатся в файловое подключение счёта, а не в банковское', async () => {
    await svc.commit({ workspaceId: seed.workspaceId, userId: seed.userId, body: body() });

    const conns = await h.prisma.integrationConnection.findMany({
      where: { workspaceId: seed.workspaceId, deletedAt: null },
      select: { id: true, provider: true, accountId: true, credentialEnc: true },
    });
    expect(conns).toHaveLength(1);
    expect(conns[0]?.provider).toBe('FILE');
    expect(conns[0]?.accountId).toBe(seed.accountId);
    // Ключа у файлового подключения нет: выписку приносит человек, а не токен.
    expect(conns[0]?.credentialEnc).toBeNull();
  });

  it('второй импорт на тот же счёт переиспользует подключение', async () => {
    await svc.commit({ workspaceId: seed.workspaceId, userId: seed.userId, body: body() });
    await svc.commit({
      workspaceId: seed.workspaceId,
      userId: seed.userId,
      body: body({
        fileHash: 'FILE-2',
        rows: [
          {
            date: '2026-05-04',
            amount: '400.00',
            type: 'INCOME',
            description: 'второй файл',
            counterpartyName: null,
            importHash: 'row-4',
            isDuplicate: false,
          },
        ],
      }),
    });

    const conns = await h.prisma.integrationConnection.count({
      where: { workspaceId: seed.workspaceId, provider: 'FILE', deletedAt: null },
    });
    expect(conns).toBe(1);
    const lines = await h.prisma.bankStatementLine.count({
      where: { workspaceId: seed.workspaceId },
    });
    expect(lines).toBe(2);
  });

  it('правило подставляет подсказку категории строке', async () => {
    const category = await h.prisma.category.create({
      data: { workspaceId: seed.workspaceId, name: 'Питание', kind: 'EXPENSE', bucket: 'VARIABLE' },
    });
    await h.prisma.rule.create({
      data: {
        workspaceId: seed.workspaceId,
        name: 'Обеды',
        priority: 10,
        isActive: true,
        appliesTo: 'IMPORT',
        conditions: [{ type: 'DESCRIPTION_CONTAINS', value: 'обед' }],
        actions: [{ type: 'SET_CATEGORY', categoryId: category.id }],
      },
    });

    await svc.commit({ workspaceId: seed.workspaceId, userId: seed.userId, body: body() });

    const line = await h.prisma.bankStatementLine.findFirst({
      where: { workspaceId: seed.workspaceId },
      select: { suggestedCategoryId: true, status: true },
    });
    // Подсказка — не проводка: строку всё равно подтверждает человек.
    expect(line?.suggestedCategoryId).toBe(category.id);
    expect(line?.status).toBe('NEW');
  });
});

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
    // Другой importHash: уникальность (connectionId, externalId) не даст завести
    // строку с тем же отпечатком дважды, пока прежняя жива.
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
            importHash: 'row-3',
            isDuplicate: false,
          },
        ],
      }),
    });
    expect(again.imported).toBe(1);
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
