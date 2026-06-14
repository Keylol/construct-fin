import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { TransferService } from './transfer.service';
import { CreateTransferSchema } from './transfer.dto';

/**
 * Юнит-тесты сервиса переводов (Полоса A, шаг A2). Prisma и UnitOfWork мокаются;
 * проверяем: создаётся ровно 2 ноги с общим transferGroupId; fee даёт 3-ю
 * транзакцию (VARIABLE_COST с тем же transferGroupId); soft-delete гасит
 * Transfer + все транзакции группы (ноги + комиссию) по transferGroupId.
 */

interface CreatedTx {
  data: Record<string, unknown>;
}

function buildService(opts: { accountIds?: string[] } = {}) {
  const created: CreatedTx[] = [];
  const accountIds = opts.accountIds ?? ['from1', 'to1'];

  const txClient = {
    transfer: {
      create: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({
          id: 'tr1',
          fromAccountId: data.fromAccountId,
          toAccountId: data.toAccountId,
          amount: data.amount,
          fee: data.fee,
          date: data.date,
          note: data.note ?? null,
          createdAt: new Date('2026-06-01T00:00:00.000Z'),
          updatedAt: new Date('2026-06-01T00:00:00.000Z'),
        }),
      ),
      update: vi.fn().mockResolvedValue(undefined),
    },
    transaction: {
      create: vi.fn().mockImplementation((arg: CreatedTx) => {
        created.push(arg);
        return Promise.resolve({ id: `tx${created.length}` });
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 2 }),
    },
  };

  const prisma = {
    transfer: {
      findMany: vi.fn(),
      findFirst: vi.fn().mockResolvedValue({ id: 'tr1', workspaceId: 'ws1', deletedAt: null }),
    },
    account: {
      findMany: vi.fn().mockResolvedValue(accountIds.map((id) => ({ id }))),
    },
  };

  const uow = {
    run: vi.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(txClient)),
  };

  const service = new TransferService(prisma as never, uow as never);
  return { service, prisma, uow, txClient, created };
}

const baseInput = {
  fromAccountId: 'from1',
  toAccountId: 'to1',
  amount: '1000.00',
  fee: '0',
  date: '2026-06-01T00:00:00.000Z',
};

describe('TransferService.create (A2)', () => {
  it('создаёт ровно 2 ноги с общим transferGroupId, без fee', async () => {
    const { service, txClient, created } = buildService();
    const result = await service.create('ws1', 'user1', { ...baseInput });

    expect(txClient.transaction.create).toHaveBeenCalledTimes(2);
    const out = created.find((c) => c.data.kind === 'TRANSFER_OUT')!;
    const inLeg = created.find((c) => c.data.kind === 'TRANSFER_IN')!;
    expect(out).toBeTruthy();
    expect(inLeg).toBeTruthy();
    // обе ноги делят transferGroupId = transfer.id
    expect(out.data.transferGroupId).toBe('tr1');
    expect(inLeg.data.transferGroupId).toBe('tr1');
    expect(out.data.type).toBe('EXPENSE');
    expect(out.data.accountId).toBe('from1');
    expect(inLeg.data.type).toBe('INCOME');
    expect(inLeg.data.accountId).toBe('to1');
    // суммы обеих ног = amount
    expect((out.data.amount as Prisma.Decimal).toFixed(2)).toBe('1000.00');
    expect((inLeg.data.amount as Prisma.Decimal).toFixed(2)).toBe('1000.00');
    expect(result.amount).toBe('1000.00');
  });

  it('fee>0 даёт 3-ю транзакцию VARIABLE_COST на счёте-источнике с transferGroupId перевода', async () => {
    const { service, txClient, created } = buildService();
    await service.create('ws1', 'user1', { ...baseInput, fee: '15.50' });

    expect(txClient.transaction.create).toHaveBeenCalledTimes(3);
    const feeTx = created.find((c) => c.data.kind === 'VARIABLE_COST')!;
    expect(feeTx).toBeTruthy();
    expect(feeTx.data.type).toBe('EXPENSE');
    expect(feeTx.data.accountId).toBe('from1');
    // комиссия привязана к transferGroupId, чтобы softDelete погасил её каскадом
    expect(feeTx.data.transferGroupId).toBe('tr1');
    expect((feeTx.data.amount as Prisma.Decimal).toFixed(2)).toBe('15.50');
  });

  it('отклоняет перевод на тот же счёт (DTO superRefine)', () => {
    const acc = 'cln1aaaaaaaaaaaaaaaaaaaaa';
    const parsed = CreateTransferSchema.safeParse({
      fromAccountId: acc,
      toAccountId: acc,
      amount: '1000.00',
      date: '2026-06-01T00:00:00.000Z',
    });
    expect(parsed.success).toBe(false);
  });

  it('принимает валидный DTO с дефолтом fee=0', () => {
    const parsed = CreateTransferSchema.parse({
      fromAccountId: 'cln1aaaaaaaaaaaaaaaaaaaaa',
      toAccountId: 'cln2bbbbbbbbbbbbbbbbbbbbb',
      amount: '1000.00',
      date: '2026-06-01T00:00:00.000Z',
    });
    expect(parsed.fee).toBe('0');
  });

  it('отклоняет неположительный amount', async () => {
    const { service } = buildService();
    await expect(service.create('ws1', 'user1', { ...baseInput, amount: '0' })).rejects.toThrow();
  });

  it('отклоняет перевод, если один из счетов не в workspace', async () => {
    const { service } = buildService({ accountIds: ['from1'] }); // нет to1
    await expect(service.create('ws1', 'user1', { ...baseInput })).rejects.toThrow();
  });
});

describe('TransferService.softDelete (A2)', () => {
  it('гасит Transfer и ноги одной UoW', async () => {
    const { service, txClient, uow } = buildService();
    await service.softDelete('ws1', 'tr1');
    expect(uow.run).toHaveBeenCalledOnce();
    expect(txClient.transfer.update).toHaveBeenCalledOnce();
    expect(txClient.transaction.updateMany).toHaveBeenCalledOnce();
    const call = txClient.transaction.updateMany.mock.calls[0]![0];
    expect(call.where.transferGroupId).toBe('tr1');
    expect(call.where.workspaceId).toBe('ws1');
    expect(call.where.deletedAt).toBeNull();
    expect(call.data.deletedAt).toBeInstanceOf(Date);
  });

  it('бросает NotFound для несуществующего перевода', async () => {
    const { service, prisma } = buildService();
    prisma.transfer.findFirst.mockResolvedValueOnce(null);
    await expect(service.softDelete('ws1', 'missing')).rejects.toThrow();
  });
});
