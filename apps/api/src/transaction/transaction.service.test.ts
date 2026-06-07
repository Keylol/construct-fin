import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { TransactionService } from './transaction.service';

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
