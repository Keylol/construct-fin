import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { findTransferMatch, type TransferCandidate } from './import.service';

/**
 * Юнит-тесты чистого ядра детекта пар-переводов (Полоса D). Без БД: проверяем
 * правила матчинга — противоположный тип, та же сумма, окно дат, выбор ближайшего.
 */

function cand(over: Partial<TransferCandidate> = {}): TransferCandidate {
  return {
    id: over.id ?? 'tx1',
    type: over.type ?? 'INCOME',
    amount: over.amount ?? new Prisma.Decimal('1000.00'),
    date: over.date ?? new Date('2026-06-10T00:00:00.000Z'),
    accountId: over.accountId ?? 'accB',
    account: over.account ?? { name: 'Эквайринг', class: 'TRANSIT' },
  };
}

const expenseRow = {
  type: 'EXPENSE' as const,
  amount: '1000.00',
  date: '2026-06-10T00:00:00.000Z',
};

describe('findTransferMatch', () => {
  it('матчит противоположный тип, ту же сумму, ту же дату', () => {
    const s = findTransferMatch(expenseRow, [cand({ type: 'INCOME' })]);
    expect(s).not.toBeNull();
    expect(s!.matchedTransactionId).toBe('tx1');
    expect(s!.otherAccountId).toBe('accB');
    expect(s!.otherAccountName).toBe('Эквайринг');
    expect(s!.otherAccountClass).toBe('TRANSIT');
    expect(s!.matchedType).toBe('INCOME');
    expect(s!.daysDiff).toBe(0);
  });

  it('НЕ матчит тот же тип (нужна контр-нога)', () => {
    const s = findTransferMatch(expenseRow, [cand({ type: 'EXPENSE' })]);
    expect(s).toBeNull();
  });

  it('НЕ матчит другую сумму', () => {
    const s = findTransferMatch(expenseRow, [
      cand({ type: 'INCOME', amount: new Prisma.Decimal('999.99') }),
    ]);
    expect(s).toBeNull();
  });

  it('НЕ матчит вне окна (>3 дней)', () => {
    const s = findTransferMatch(expenseRow, [
      cand({ type: 'INCOME', date: new Date('2026-06-15T00:00:00.000Z') }), // 5 дней
    ]);
    expect(s).toBeNull();
  });

  it('матчит на границе окна (ровно 3 дня)', () => {
    const s = findTransferMatch(expenseRow, [
      cand({ type: 'INCOME', date: new Date('2026-06-13T00:00:00.000Z') }),
    ]);
    expect(s).not.toBeNull();
    expect(s!.daysDiff).toBe(3);
  });

  it('НЕ матчит 3 дня + несколько часов (гейт по точным мс, не по округлению)', () => {
    const s = findTransferMatch(expenseRow, [
      cand({ type: 'INCOME', date: new Date('2026-06-13T05:00:00.000Z') }), // 3д 5ч
    ]);
    expect(s).toBeNull();
  });

  it('из нескольких подходящих берёт ближайший по дате', () => {
    const s = findTransferMatch(expenseRow, [
      cand({ id: 'far', type: 'INCOME', date: new Date('2026-06-12T00:00:00.000Z') }), // 2 дня
      cand({ id: 'near', type: 'INCOME', date: new Date('2026-06-11T00:00:00.000Z') }), // 1 день
    ]);
    expect(s!.matchedTransactionId).toBe('near');
    expect(s!.daysDiff).toBe(1);
  });

  it('INCOME-строка матчит EXPENSE-кандидата (перевод в обратную сторону)', () => {
    const incomeRow = { type: 'INCOME' as const, amount: '500.00', date: '2026-06-10T00:00:00.000Z' };
    const s = findTransferMatch(incomeRow, [
      cand({ type: 'EXPENSE', amount: new Prisma.Decimal('500.00') }),
    ]);
    expect(s).not.toBeNull();
    expect(s!.matchedType).toBe('EXPENSE');
  });

  it('пустой список кандидатов → null', () => {
    expect(findTransferMatch(expenseRow, [])).toBeNull();
  });
});
