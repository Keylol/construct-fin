/**
 * Волна 2, PR 2.2 — GH8: откат импортированной выписки целиком.
 *
 * С переходом импорта на «Входящие» откат снимает строки пакета, а вместе с
 * ними — проводки, которые из этих строк родились. Прежние пакеты (файл сразу
 * создавал операции) откатываются по-старому: на проде такие лежат, и ломать их
 * откат нельзя.
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
        importHash: 'row-1',
        isDuplicate: false,
      },
    ],
    ...over,
  };
}

/** Разбор строки: операция + связь, как это делает Inbox.categorize. */
async function settleLine(lineId: string, over: { adopted?: boolean; orderId?: string } = {}) {
  const line = await h.prisma.bankStatementLine.findUniqueOrThrow({ where: { id: lineId } });
  const tx = await h.prisma.transaction.create({
    data: {
      workspaceId: seed.workspaceId,
      accountId: seed.accountId,
      date: line.date,
      amount: line.amount,
      type: line.direction,
      kind: over.orderId ? 'ORDER_PAYMENT' : 'OTHER',
      orderId: over.orderId ?? null,
      description: line.description,
      createdById: seed.userId,
    },
  });
  await h.prisma.bankStatementLine.update({
    where: { id: lineId },
    data: { status: 'RESOLVED', transactionId: tx.id, adopted: over.adopted ?? false },
  });
  return tx;
}

describe('GH8: откат импорта', () => {
  it('откат сносит строки и батч, возвращает счётчик', async () => {
    const res = await svc.commit({ workspaceId: seed.workspaceId, userId: seed.userId, body: body() });
    const reverted = await svc.revertBatch(seed.workspaceId, res.batchId, seed.userId);
    expect(reverted.reverted).toBe(1);

    const lines = await h.prisma.bankStatementLine.count({
      where: { importBatchId: res.batchId },
    });
    expect(lines).toBe(0);
    const batch = await h.prisma.importBatch.findUniqueOrThrow({ where: { id: res.batchId } });
    expect(batch.deletedAt).not.toBeNull();
    // Аудит.
    const audit = await h.prisma.auditLog.findFirst({
      where: { workspaceId: seed.workspaceId, action: 'import.revert' },
    });
    expect(audit!.entityId).toBe(res.batchId);
  });

  it('разобранная строка уходит вместе со своей проводкой', async () => {
    const res = await svc.commit({ workspaceId: seed.workspaceId, userId: seed.userId, body: body() });
    const line = await h.prisma.bankStatementLine.findFirstOrThrow({
      where: { importBatchId: res.batchId },
    });
    const tx = await settleLine(line.id);

    await svc.revertBatch(seed.workspaceId, res.batchId, seed.userId);

    const alive = await h.prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } });
    expect(alive.deletedAt).not.toBeNull();
  });

  it('усыновлённая операция переживает откат — она была до импорта', async () => {
    const res = await svc.commit({ workspaceId: seed.workspaceId, userId: seed.userId, body: body() });
    const line = await h.prisma.bankStatementLine.findFirstOrThrow({
      where: { importBatchId: res.batchId },
    });
    const tx = await settleLine(line.id, { adopted: true });

    await svc.revertBatch(seed.workspaceId, res.batchId, seed.userId);

    // Строки нет, а запись человека осталась нетронутой.
    const gone = await h.prisma.bankStatementLine.count({ where: { id: line.id } });
    expect(gone).toBe(0);
    const alive = await h.prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } });
    expect(alive.deletedAt).toBeNull();
  });

  it('строка, сведённая в перевод, блокирует откат пакета', async () => {
    const res = await svc.commit({ workspaceId: seed.workspaceId, userId: seed.userId, body: body() });
    const line = await h.prisma.bankStatementLine.findFirstOrThrow({
      where: { importBatchId: res.batchId },
    });
    const transfer = await h.prisma.transfer.create({
      data: {
        workspaceId: seed.workspaceId,
        fromAccountId: seed.accountId,
        toAccountId: seed.accountId,
        amount: line.amount,
        fee: '0',
        date: line.date,
        createdById: seed.userId,
      },
    });
    await h.prisma.bankStatementLine.update({
      where: { id: line.id },
      data: { transferId: transfer.id, status: 'RESOLVED' },
    });

    await expect(
      svc.revertBatch(seed.workspaceId, res.batchId, seed.userId),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('откат оплаты заказа возвращает paidAmount к нулю', async () => {
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
            importHash: 'pay-1',
            isDuplicate: false,
          },
        ],
      }),
    });
    const line = await h.prisma.bankStatementLine.findFirstOrThrow({
      where: { importBatchId: res.batchId },
    });
    await settleLine(line.id, { orderId: order.id });
    await h.orders.recalcPaymentState(seed.workspaceId, order.id, h.prisma);

    let ord = await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(ord.paidAmount.toFixed(2)).toBe('1000.00');

    const reverted = await svc.revertBatch(seed.workspaceId, res.batchId, seed.userId);
    expect(reverted.ordersRecalced).toBe(1);
    ord = await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(ord.paidAmount.toFixed(2)).toBe('0.00');
    expect(ord.paymentStatus).toBe('UNPAID');
  });

  it('прежний пакет с проводками откатывается по-старому', async () => {
    // Пакет поколения «файл создаёт операции сразу» — такие лежат на проде.
    const batch = await h.prisma.importBatch.create({
      data: {
        workspaceId: seed.workspaceId,
        userId: seed.userId,
        source: 'GENERIC_CSV',
        filename: 'legacy.csv',
        fileHash: 'FILE-LEGACY',
        rowsTotal: 1,
        rowsImported: 1,
        rowsSkipped: 0,
      },
    });
    const tx = await h.prisma.transaction.create({
      data: {
        workspaceId: seed.workspaceId,
        accountId: seed.accountId,
        date: new Date('2026-05-01T00:00:00Z'),
        amount: '100.00',
        type: 'EXPENSE',
        description: 'старый импорт',
        importBatchId: batch.id,
        importHash: 'legacy-1',
        createdById: seed.userId,
      },
    });

    const reverted = await svc.revertBatch(seed.workspaceId, batch.id, seed.userId);
    expect(reverted.reverted).toBe(1);
    const dead = await h.prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } });
    expect(dead.deletedAt).not.toBeNull();
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
    // После отката — тот же fileHash проходит, и строка заводится снова: её
    // externalId освободился вместе с удалением прежней.
    const again = await svc.commit({ workspaceId: seed.workspaceId, userId: seed.userId, body: body() });
    expect(again.imported).toBe(1);
  });

  it('чужой/несуществующий батч → 404', async () => {
    await expect(
      svc.revertBatch(seed.workspaceId, 'cme00000000000000000000zz', seed.userId),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('гонка: откат + параллельная оплата — ручной платёж не теряется (FOR UPDATE)', async () => {
    const order = await h.orders.create(seed.workspaceId, {
      items: [{ name: 'Товар', qty: '1', unitPrice: '1000' }],
    });
    const res = await svc.commit({
      workspaceId: seed.workspaceId,
      userId: seed.userId,
      body: body({
        fileHash: 'FILE-RACE',
        rows: [
          {
            date: '2026-05-01',
            amount: '600.00',
            type: 'INCOME',
            description: 'импорт-оплата',
            counterpartyName: null,
            importHash: 'race-1',
            isDuplicate: false,
          },
        ],
      }),
    });
    const line = await h.prisma.bankStatementLine.findFirstOrThrow({
      where: { importBatchId: res.batchId },
    });
    await settleLine(line.id, { orderId: order.id });
    await h.orders.recalcPaymentState(seed.workspaceId, order.id, h.prisma);

    // Откат импорта и ручная оплата 400 — параллельно. Лок сериализует: что бы ни
    // закоммитилось первым, импортные 600 уходят, ручные 400 остаются → paidAmount=400.
    await Promise.all([
      svc.revertBatch(seed.workspaceId, res.batchId, seed.userId),
      h.orders.addPayment(seed.workspaceId, order.id, seed.userId, {
        amount: '400.00',
        accountId: seed.accountId,
      }),
    ]);
    const ord = await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(ord.paidAmount.toFixed(2)).toBe('400.00');
  });
});
