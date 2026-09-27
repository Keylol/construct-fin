import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  ausnMonthTax,
  ausnSumsByMonth,
  classifyAusnWithBucket,
  inferredTaxPeriod,
  taxPaidByPeriod,
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

  it('наличные в базу не входят ни доходом, ни расходом', () => {
    expect(classifyAusnWithBucket(t({ type: 'INCOME', kind: 'ORDER_PAYMENT', accountType: 'CASH' }))).toBe('NOT_COUNTED');
    expect(classifyAusnWithBucket(t({ kind: 'SALARY', accountType: 'CASH' }))).toBe('NOT_COUNTED');
    expect(classifyAusnWithBucket(t({ type: 'INCOME', kind: 'ORDER_PAYMENT', accountType: 'BANK' }))).toBe('INCOME_PLUS');
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

  it('день платежа берётся в поясе бизнеса (UTC+5)', () => {
    // 14.09 20:00 UTC — уже 15 сентября в Екатеринбурге → налог за август.
    expect(inferredTaxPeriod(new Date('2026-09-14T20:00:00.000Z'))).toBe('2026-08');
    // 14.09 18:00 UTC — ещё 14-е: сумма за август не пришла → доплата за июль.
    expect(inferredTaxPeriod(new Date('2026-09-14T18:00:00.000Z'))).toBe('2026-07');
  });

  it('платёж до 15-го — доплата за позапрошлый месяц', () => {
    // 3 300 от 10.09.2026 — не август: его сумму налоговая присылает к 15.09.
    expect(inferredTaxPeriod(new Date('2026-09-10T16:50:00.000Z'))).toBe('2026-07');
    // Через год: 5 февраля → декабрь прошлого года.
    expect(inferredTaxPeriod(new Date('2027-02-05T07:00:00.000Z'))).toBe('2026-12');
    // Август бухгалтер заплатил 27.09 — это август.
    expect(inferredTaxPeriod(new Date('2026-09-27T07:00:00.000Z'))).toBe('2026-08');
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

describe('taxPaidByPeriod — за какой месяц уплачено', () => {
  const pay = (o: { kind?: 'TAX' | 'OTHER'; taxPeriod?: string | null; amount: string; date: string }) => ({
    kind: o.kind ?? 'OTHER',
    taxPeriod: o.taxPeriod ?? null,
    amount: new Prisma.Decimal(o.amount),
    date: new Date(o.date),
  });
  const labels = new Set(['2026-06', '2026-07', '2026-08']);

  it('ЕНП из выписки — за месяц перед платежом, два платежа одного дня суммируются', () => {
    const paid = taxPaidByPeriod(
      [
        pay({ amount: '21415', date: '2026-07-26T13:42:00.000Z' }),
        pay({ amount: '104377', date: '2026-07-26T13:42:00.000Z' }),
        pay({ amount: '141621', date: '2026-08-25T05:07:00.000Z' }),
      ],
      labels,
    );
    expect(paid.get('2026-06')?.toFixed(2)).toBe('125792.00');
    expect(paid.get('2026-07')?.toFixed(2)).toBe('141621.00');
  });

  it('«Уплатить» — по явному периоду; отметка периода у ЕНП главнее даты', () => {
    const paid = taxPaidByPeriod(
      [
        pay({ kind: 'TAX', taxPeriod: '2026-06', amount: '1000', date: '2026-09-01T07:00:00.000Z' }),
        pay({ taxPeriod: '2026-06', amount: '500', date: '2026-09-10T07:00:00.000Z' }),
        pay({ kind: 'TAX', taxPeriod: null, amount: '999', date: '2026-07-10T07:00:00.000Z' }),
      ],
      labels,
    );
    expect(paid.get('2026-06')?.toFixed(2)).toBe('1500.00');
    expect(paid.size).toBe(1);
  });

  it('месяцы вне набора не попадают', () => {
    const paid = taxPaidByPeriod([pay({ amount: '174000', date: '2026-06-28T13:12:00.000Z' })], labels);
    expect(paid.size).toBe(0); // за май, а май не в наборе
  });
});
