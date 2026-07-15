import { describe, expect, it } from 'vitest';
import { classifyAusn, AUSN_RATE, AUSN_MIN_RATE } from './ausn-classify';
import type { AusnMark, TransactionKind, TxType } from '@prisma/client';

const tx = (kind: TransactionKind, type: TxType, ausnMark: AusnMark | null = null) => ({
  kind,
  type,
  ausnMark,
});

describe('classifyAusn', () => {
  it('маркировка/переопределение приоритетнее авто-разбора', () => {
    // Даже перевод, помеченный вручную как доход, идёт в доход.
    expect(classifyAusn(tx('TRANSFER_IN', 'INCOME', 'INCOME'))).toBe('INCOME_PLUS');
    expect(classifyAusn(tx('ORDER_PAYMENT', 'INCOME', 'NOT_COUNTED'))).toBe('NOT_COUNTED');
    expect(classifyAusn(tx('PURCHASE', 'EXPENSE', 'EXPENSE'))).toBe('EXPENSE_PLUS');
  });

  it('доход: оплата заказа и деловой приход', () => {
    expect(classifyAusn(tx('ORDER_PAYMENT', 'INCOME'))).toBe('INCOME_PLUS');
    expect(classifyAusn(tx('OTHER', 'INCOME'))).toBe('INCOME_PLUS');
    expect(classifyAusn(tx('NON_OP', 'INCOME'))).toBe('INCOME_PLUS');
  });

  it('возврат клиенту — минус доход', () => {
    expect(classifyAusn(tx('ORDER_REFUND', 'EXPENSE'))).toBe('INCOME_MINUS');
  });

  it('расход: закупка, зарплата, постоянные/переменные, деловой расход', () => {
    expect(classifyAusn(tx('PURCHASE', 'EXPENSE'))).toBe('EXPENSE_PLUS');
    expect(classifyAusn(tx('SALARY', 'EXPENSE'))).toBe('EXPENSE_PLUS');
    expect(classifyAusn(tx('FIXED_COST', 'EXPENSE'))).toBe('EXPENSE_PLUS');
    expect(classifyAusn(tx('VARIABLE_COST', 'EXPENSE'))).toBe('EXPENSE_PLUS');
    expect(classifyAusn(tx('OTHER', 'EXPENSE'))).toBe('EXPENSE_PLUS');
    expect(classifyAusn(tx('NON_OP', 'EXPENSE'))).toBe('EXPENSE_PLUS');
  });

  it('возврат от поставщика — минус расход', () => {
    expect(classifyAusn(tx('SUPPLIER_REFUND', 'INCOME'))).toBe('EXPENSE_MINUS');
  });

  it('вне базы: неденежное, переводы, капитал, сам налог', () => {
    for (const k of ['COGS', 'WRITE_OFF', 'TRANSFER_IN', 'TRANSFER_OUT', 'CAPITAL_IN', 'CAPITAL_OUT', 'TAX'] as const) {
      expect(classifyAusn(tx(k, k === 'TRANSFER_IN' || k === 'CAPITAL_IN' ? 'INCOME' : 'EXPENSE'))).toBe('NOT_COUNTED');
    }
  });

  it('ставки АУСН Д−Р зафиксированы', () => {
    expect(AUSN_RATE).toBe(0.2);
    expect(AUSN_MIN_RATE).toBe(0.03);
  });
});
