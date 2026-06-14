import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { AccountService } from './account.service';
import { CreateAccountSchema } from './account.dto';

/**
 * Юнит-тесты Account.class (Полоса A, шаг A1): значение класса доходит до БД при
 * create/update и возвращается в serialize. PrismaService мокается.
 */

function makeAccount(over: Record<string, unknown> = {}) {
  return {
    id: 'acc1',
    name: 'Касса',
    type: 'CASH',
    class: 'OPERATING',
    openingBalance: new Prisma.Decimal('0.00'),
    note: null,
    isArchived: false,
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    updatedAt: new Date('2026-06-01T00:00:00.000Z'),
    ...over,
  };
}

describe('AccountService — Account.class (A1)', () => {
  it('create передаёт class в data и возвращает его в serialize', async () => {
    const prisma = {
      account: {
        create: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve(makeAccount({ class: data.class })),
        ),
      },
    };
    const service = new AccountService(prisma as never);
    const result = await service.create('ws1', {
      name: 'Эквайринг',
      type: 'BANK',
      class: 'TRANSIT',
      openingBalance: '0',
    });
    expect(prisma.account.create).toHaveBeenCalledOnce();
    expect(prisma.account.create.mock.calls[0]![0].data.class).toBe('TRANSIT');
    expect(result.class).toBe('TRANSIT');
  });

  it('CreateAccountSchema по умолчанию ставит class=OPERATING', () => {
    const parsed = CreateAccountSchema.parse({ name: 'Р/с', type: 'BANK' });
    expect(parsed.class).toBe('OPERATING');
  });

  it('update прокидывает class', async () => {
    const prisma = {
      account: {
        findFirst: vi.fn().mockResolvedValue(makeAccount()),
        update: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve(makeAccount({ class: data.class ?? 'OPERATING' })),
        ),
      },
    };
    const service = new AccountService(prisma as never);
    const result = await service.update('ws1', 'acc1', { class: 'PERSONAL' });
    expect(prisma.account.update.mock.calls[0]![0].data.class).toBe('PERSONAL');
    expect(result.class).toBe('PERSONAL');
  });
});
