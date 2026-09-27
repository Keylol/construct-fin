import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  ausnMonthTax,
  ausnSumsByMonth,
  classifyAusnWithBucket,
  inferredTaxPeriod,
  type AusnTx,
} from './ausn-tax';

const t = (o: Partial<AusnTx>): AusnTx => ({
  type: 'EXPENSE',
  kind: 'OTHER',
  ausnMark: null,
  amount: new Prisma.Decimal('1000'),
  date: new Date('2026-08-15T07:00:00.000Z'),
  categoryBucket: null,
  ...o,
});

describe('classifyAusnWithBucket — группа статьи уточняет знак', () => {
  it('ЕНП из выписки (статья «Налоги») в базу не входит', () => {
    expect(classifyAusnWithBucket(t({ categoryBucket: 'TAX' }))).toBe('NOT_COUNTED');
  });

  it('вложения и изъятия собственника в базу не входят', () => {
    expect(classifyAusnWithBucket(t({ type: 'INCOME', categoryBucket: 'CAPITAL' }))).toBe('NOT_COUNTED');
    expect(classifyAusnWithBucket(t({ categoryBucket: 'CAPITAL' }))).toBe('NOT_COUNTED');
  });

  it('возврат от поставщика уменьшает расход, а не увеличивает доход', () => {
    expect(classifyAusnWithBucket(t({ type: 'INCOME', categoryBucket: 'PURCHASES' }))).toBe('EXPENSE_MINUS');
  });

  it('маркировка банка главнее группы статьи', () => {
    expect(classifyAusnWithBucket(t({ categoryBucket: 'TAX', ausnMark: 'EXPENSE' }))).toBe('EXPENSE_PLUS');
  });

  it('обычные статьи — по знаку, как раньше', () => {
    expect(classifyAusnWithBucket(t({ categoryBucket: 'FIXED' }))).toBe('EXPENSE_PLUS');
    expect(classifyAusnWithBucket(t({ type: 'INCOME', categoryBucket: 'REVENUE' }))).toBe('INCOME_PLUS');
  });
});

describe('ausnMonthTax — max(20 % базы, 3 % дохода)', () => {
  const sums = (income: string, expense: string) => ({
    income: new Prisma.Decimal(income),
    expense: new Prisma.Decimal(expense),
    incomeCount: 1,
    expenseCount: 1,
  });

  it('с прибылью — 20 % с базы', () => {
    expect(ausnMonthTax(sums('100000', '40000')).taxDue.toFixed(2)).toBe('12000.00');
  });

  it('с малой базой — минимальный налог 3 % с дохода', () => {
    expect(ausnMonthTax(sums('100000', '95000')).taxDue.toFixed(2)).toBe('3000.00');
  });

  it('пустой месяц — ноль', () => {
    expect(ausnMonthTax(undefined).taxDue.toFixed(2)).toBe('0.00');
  });
});

describe('inferredTaxPeriod — ЕНП платится за прошлый месяц', () => {
  it('платёж 25 августа — налог за июль', () => {
    expect(inferredTaxPeriod(new Date('2026-08-25T07:00:00.000Z'))).toBe('2026-07');
  });

  it('январский платёж — за декабрь прошлого года', () => {
    expect(inferredTaxPeriod(new Date('2027-01-20T07:00:00.000Z'))).toBe('2026-12');
  });

  it('месяц платежа берётся в поясе бизнеса (UTC+5)', () => {
    // 31.08 20:00 UTC — уже 1 сентября в Екатеринбурге → налог за август.
    expect(inferredTaxPeriod(new Date('2026-08-31T20:00:00.000Z'))).toBe('2026-08');
  });
});

describe('ausnSumsByMonth — месяцы по поясу бизнеса', () => {
  it('вечер 31 августа по UTC уходит в сентябрь', () => {
    const m = ausnSumsByMonth([
      t({ type: 'INCOME', kind: 'ORDER_PAYMENT', date: new Date('2026-08-31T18:00:00.000Z') }),
      t({ type: 'INCOME', kind: 'ORDER_PAYMENT', date: new Date('2026-08-31T20:00:00.000Z') }),
    ]);
    expect(m.get('2026-08')?.income.toFixed(2)).toBe('1000.00');
    expect(m.get('2026-09')?.income.toFixed(2)).toBe('1000.00');
  });
});
