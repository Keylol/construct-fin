/**
 * Интеграционные тесты бюджета план/факт: факт по категории включает
 * подкатегории, возвраты уменьшают факт, partial-unique активной строки,
 * INCOME-план без флага «перерасход», cross-tenant изоляция.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { buildHarness, resetDb, seedBase, type Harness, type Seed } from '../test/money-harness';

let h: Harness;
let seed: Seed;
let tg = 3_500_000n;

beforeAll(() => {
  h = buildHarness();
});
afterAll(async () => {
  await h.prisma.$disconnect();
});
beforeEach(async () => {
  await resetDb(h.prisma);
  tg += 1n;
  seed = await seedBase(h.prisma, tg);
});

async function seedCategory(
  workspaceId: string,
  name: string,
  kind: 'INCOME' | 'EXPENSE',
  parentId: string | null = null,
) {
  return h.prisma.category.create({
    data: { workspaceId, name, kind, parentId },
  });
}

async function seedTx(params: {
  categoryId: string;
  type: 'INCOME' | 'EXPENSE';
  amount: string;
  date?: Date;
}) {
  await h.prisma.transaction.create({
    data: {
      workspaceId: seed.workspaceId,
      accountId: seed.accountId,
      categoryId: params.categoryId,
      type: params.type,
      kind: params.type === 'EXPENSE' ? 'FIXED_COST' : 'OTHER',
      amount: params.amount,
      date: params.date ?? new Date(),
      createdById: seed.userId,
    },
  });
}

describe('Бюджет план/факт', () => {
  it('факт включает подкатегории; возврат уменьшает факт; usage и over считаются', async () => {
    const parent = await seedCategory(seed.workspaceId, 'Продвижение', 'EXPENSE');
    const child = await seedCategory(seed.workspaceId, 'Реклама', 'EXPENSE', parent.id);
    await h.budgets.create(seed.workspaceId, seed.userId, {
      categoryId: parent.id,
      amount: '50000.00',
    });

    await seedTx({ categoryId: parent.id, type: 'EXPENSE', amount: '20000.00' });
    await seedTx({ categoryId: child.id, type: 'EXPENSE', amount: '25000.00' });
    // Возврат расхода по подкатегории — минус из факта.
    await seedTx({ categoryId: child.id, type: 'INCOME', amount: '5000.00' });

    const report = await h.budgets.list(seed.workspaceId, {});
    expect(report.rows).toHaveLength(1);
    const row = report.rows[0]!;
    expect(row.amount).toBe('50000.00');
    expect(row.fact).toBe('40000.00'); // 20 + 25 − 5
    expect(row.usagePct).toBe(80);
    expect(row.over).toBe(false);
    expect(report.totals.expensePlan).toBe('50000.00');
    expect(report.totals.expenseFact).toBe('40000.00');
    expect(report.totals.overCount).toBe(0);

    // Добиваем сверх лимита → over.
    await seedTx({ categoryId: parent.id, type: 'EXPENSE', amount: '15000.00' });
    const after = await h.budgets.list(seed.workspaceId, {});
    expect(after.rows[0]!.fact).toBe('55000.00');
    expect(after.rows[0]!.over).toBe(true);
    expect(after.totals.overCount).toBe(1);
  });

  it('прошлый месяц не попадает в факт текущего; параметр month возвращает его', async () => {
    const cat = await seedCategory(seed.workspaceId, 'Аренда', 'EXPENSE');
    await h.budgets.create(seed.workspaceId, seed.userId, {
      categoryId: cat.id,
      amount: '30000.00',
    });
    const now = new Date();
    const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15, 12);
    await seedTx({ categoryId: cat.id, type: 'EXPENSE', amount: '30000.00', date: prevMonth });

    const current = await h.budgets.list(seed.workspaceId, {});
    expect(current.rows[0]!.fact).toBe('0.00');

    const label = `${prevMonth.getFullYear()}-${String(prevMonth.getMonth() + 1).padStart(2, '0')}`;
    const prev = await h.budgets.list(seed.workspaceId, { month: label });
    expect(prev.month).toBe(label);
    expect(prev.rows[0]!.fact).toBe('30000.00');
  });

  it('второй активный бюджет на категорию → конфликт; после удаления можно завести заново', async () => {
    const cat = await seedCategory(seed.workspaceId, 'Связь', 'EXPENSE');
    const first = await h.budgets.create(seed.workspaceId, seed.userId, {
      categoryId: cat.id,
      amount: '5000.00',
    });
    await expect(
      h.budgets.create(seed.workspaceId, seed.userId, { categoryId: cat.id, amount: '9000.00' }),
    ).rejects.toBeInstanceOf(ConflictException);

    await h.budgets.remove(seed.workspaceId, first.id);
    const again = await h.budgets.create(seed.workspaceId, seed.userId, {
      categoryId: cat.id,
      amount: '9000.00',
    });
    expect(again.id).toBeTruthy();
  });

  it('INCOME-план: недобор не считается перерасходом, факт нетто', async () => {
    const inc = await seedCategory(seed.workspaceId, 'Продажи услуг', 'INCOME');
    await h.budgets.create(seed.workspaceId, seed.userId, {
      categoryId: inc.id,
      amount: '100000.00',
    });
    await seedTx({ categoryId: inc.id, type: 'INCOME', amount: '60000.00' });

    const report = await h.budgets.list(seed.workspaceId, {});
    const row = report.rows[0]!;
    expect(row.kind).toBe('INCOME');
    expect(row.fact).toBe('60000.00');
    expect(row.usagePct).toBe(60);
    expect(row.over).toBe(false);
    expect(report.totals.incomePlan).toBe('100000.00');
    expect(report.totals.incomeFact).toBe('60000.00');
  });

  it('cross-tenant: чужие бюджеты и транзакции не видны', async () => {
    tg += 1n;
    const other = await seedBase(h.prisma, tg);
    const otherCat = await seedCategory(other.workspaceId, 'Чужая', 'EXPENSE');
    await h.budgets.create(other.workspaceId, other.userId, {
      categoryId: otherCat.id,
      amount: '77777.00',
    });

    const mine = await h.budgets.list(seed.workspaceId, {});
    expect(mine.rows).toHaveLength(0);
    // Правка чужого бюджета из моего пространства не проходит.
    const theirs = await h.budgets.list(other.workspaceId, {});
    await expect(
      h.budgets.update(seed.workspaceId, theirs.rows[0]!.id, { amount: '1.00' }),
    ).rejects.toThrow();
  });
});
