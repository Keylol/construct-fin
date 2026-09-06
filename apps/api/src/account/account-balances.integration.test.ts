import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildHarness, resetDb, seedBase, type Harness, type Seed } from '../test/money-harness';
import { AccountService } from './account.service';

/**
 * GET /accounts/balances: три числа по счёту. Проверяем арифметику на реальной
 * БД: «по учёту» = начальный + проводки (без COGS), «по банку» — с подключения,
 * «не разобрано» — строки NEW, расхождение = банк − учёт − неразобранное.
 */
let h: Harness;
let seed: Seed;
let service: AccountService;
let tg = 1950000n;

beforeAll(() => {
  h = buildHarness();
  service = new AccountService(h.prisma as never);
});
afterAll(async () => {
  await h.prisma.$disconnect();
});
beforeEach(async () => {
  await resetDb(h.prisma);
  tg += 1n;
  seed = await seedBase(h.prisma, tg);
});

async function tx(type: 'INCOME' | 'EXPENSE', amount: string, kind: 'OTHER' | 'COGS' = 'OTHER') {
  return h.prisma.transaction.create({
    data: {
      workspaceId: seed.workspaceId,
      accountId: seed.accountId,
      date: new Date('2026-07-05T00:00:00.000Z'),
      amount,
      type,
      kind,
      createdById: seed.userId,
    },
  });
}

describe('AccountService.balances', () => {
  it('счёт без подключения: только «по учёту», банк и расхождение null', async () => {
    await h.prisma.account.update({ where: { id: seed.accountId }, data: { openingBalance: '100.00' } });
    await tx('INCOME', '50.00');
    await tx('EXPENSE', '20.00');
    await tx('EXPENSE', '999.00', 'COGS'); // неденежный — в остаток не входит

    const row = (await service.balances(seed.workspaceId))[0]!;
    expect(row).toMatchObject({
      accountId: seed.accountId,
      ledger: '130.00',
      bank: null,
      bankAt: null,
      unresolvedCount: 0,
      unresolvedNet: '0.00',
      discrepancy: null,
      anchoredAt: null,
    });
  });

  it('с подключением: банк, неразобранные строки и расхождение', async () => {
    const at = new Date('2026-07-10T12:00:00.000Z');
    await h.prisma.account.update({
      where: { id: seed.accountId },
      data: { openingBalance: '1000.00', openingAnchoredAt: at },
    });
    const conn = await h.prisma.integrationConnection.create({
      data: {
        workspaceId: seed.workspaceId,
        provider: 'TBANK',
        accountId: seed.accountId,
        credentialEnc: 'x',
        keyLast4: '1234',
        createdById: seed.userId,
        bankBalance: '1500.00',
        bankBalanceAt: at,
      },
    });
    await tx('INCOME', '200.00'); // учёт: 1000 + 200 = 1200
    const line = (externalId: string, direction: 'INCOME' | 'EXPENSE', amount: string, status: 'NEW' | 'DISMISSED') =>
      h.prisma.bankStatementLine.create({
        data: {
          workspaceId: seed.workspaceId,
          connectionId: conn.id,
          externalId,
          date: at,
          amount,
          direction,
          status,
        },
      });
    await line('l1', 'INCOME', '400.00', 'NEW');
    await line('l2', 'EXPENSE', '50.00', 'NEW');
    await line('l3', 'EXPENSE', '50.00', 'DISMISSED'); // разобрана как «не учитывать» — в очередь не входит

    const row = (await service.balances(seed.workspaceId))[0]!;
    expect(row.ledger).toBe('1200.00');
    expect(row.bank).toBe('1500.00');
    expect(row.bankAt).toBe(at.toISOString());
    expect(row.unresolvedCount).toBe(2);
    expect(row.unresolvedNet).toBe('350.00');
    // 1500 − 1200 − 350 = −50: ровно «не учитываемая» строка, которую банк провёл.
    expect(row.discrepancy).toBe('-50.00');
    expect(row.anchoredAt).toBe(at.toISOString());
  });
});
