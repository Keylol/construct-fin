/**
 * Волна 2, PR 2.2 — GH8: откат импортированной выписки целиком.
 * soft-delete проводок + батча + переигровка оплаты привязанных заказов + аудит.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { ImportService } from './import.service';
import type { CommitBody } from './import.dto';
import { PrismaService } from '../prisma/prisma.service';
import { buildHarness, resetDb, seedBase, type Harness, type Seed } from '../test/money-harness';

let h: Harness;
let svc: ImportService;
let seed: Seed;
let tg = 2810000n;

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
    fileHash: 'FILE-REV',
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

describe('GH8: откат импорта', () => {
  it('откат soft-удаляет проводки и батч, возвращает счётчик', async () => {
    const res = await svc.commit({ workspaceId: seed.workspaceId, userId: seed.userId, body: body() });
    const reverted = await svc.revertBatch(seed.workspaceId, res.batchId, seed.userId);
    expect(reverted.reverted).toBe(1);

    const txs = await h.prisma.transaction.findMany({
      where: { importBatchId: res.batchId, deletedAt: null },
    });
    expect(txs.length).toBe(0);
    const batch = await h.prisma.importBatch.findUniqueOrThrow({ where: { id: res.batchId } });
    expect(batch.deletedAt).not.toBeNull();
    // Аудит.
    const audit = await h.prisma.auditLog.findFirst({
      where: { workspaceId: seed.workspaceId, action: 'import.revert' },
    });
    expect(audit!.entityId).toBe(res.batchId);
  });

  it('откат привязанной оплаты возвращает paidAmount заказа к нулю', async () => {
    const order = await h.orders.create(seed.workspaceId, {
      items: [{ name: 'Товар', qty: '1', unitPrice: '1000' }],
    });
    const res = await svc.commit({
      workspaceId: seed.workspaceId,
      userId: seed.userId,
      body: body({
        fileHash: 'FILE-PAY',
        rows: [
          {
            date: '2026-05-01',
            amount: '1000.00',
            type: 'INCOME',
            description: 'оплата заказа',
            counterpartyName: null,
            categoryId: null,
            importHash: 'pay-1',
            isDuplicate: false,
            orderId: order.id,
          },
        ],
      }),
    });
    // После импорта заказ оплачен.
    let ord = await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(ord.paidAmount.toFixed(2)).toBe('1000.00');
    expect(ord.paymentStatus).toBe('PAID');

    const reverted = await svc.revertBatch(seed.workspaceId, res.batchId, seed.userId);
    expect(reverted.ordersRecalced).toBe(1);
    ord = await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(ord.paidAmount.toFixed(2)).toBe('0.00');
    expect(ord.paymentStatus).toBe('UNPAID');
  });

  it('повторный откат того же батча → 404', async () => {
    const res = await svc.commit({ workspaceId: seed.workspaceId, userId: seed.userId, body: body() });
    await svc.revertBatch(seed.workspaceId, res.batchId, seed.userId);
    await expect(svc.revertBatch(seed.workspaceId, res.batchId, seed.userId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('после отката тот же файл можно импортировать заново', async () => {
    const first = await svc.commit({ workspaceId: seed.workspaceId, userId: seed.userId, body: body() });
    // До отката — повтор файла даёт 409.
    await expect(
      svc.commit({ workspaceId: seed.workspaceId, userId: seed.userId, body: body() }),
    ).rejects.toBeInstanceOf(ConflictException);
    await svc.revertBatch(seed.workspaceId, first.batchId, seed.userId);
    // После отката — тот же fileHash проходит (partial-unique освобождён).
    const again = await svc.commit({ workspaceId: seed.workspaceId, userId: seed.userId, body: body() });
    expect(again.imported).toBe(1);
  });

  it('чужой/несуществующий батч → 404', async () => {
    await expect(
      svc.revertBatch(seed.workspaceId, 'cme00000000000000000000zz', seed.userId),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
