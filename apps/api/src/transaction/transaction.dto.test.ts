import { describe, expect, it } from 'vitest';
import {
  CreateTransactionSchema,
  UpdateTransactionSchema,
  ListTransactionsQuerySchema,
} from './transaction.dto';

describe('CreateTransactionSchema', () => {
  const base = {
    date: '2026-05-23T12:00:00.000Z',
    amount: '1234.56',
    type: 'EXPENSE' as const,
    accountId: 'cuid_account_1',
  };

  it('accepts a minimal valid payload', () => {
    const parsed = CreateTransactionSchema.parse(base);
    expect(parsed.amount).toBe('1234.56');
    expect(parsed.type).toBe('EXPENSE');
  });

  it('accepts optional category, counterparty, description', () => {
    const parsed = CreateTransactionSchema.parse({
      ...base,
      categoryId: 'cuid_cat',
      counterpartyId: 'cuid_cp',
      description: 'обед',
    });
    expect(parsed.categoryId).toBe('cuid_cat');
    expect(parsed.description).toBe('обед');
  });

  it('rejects float amounts with 3 decimals', () => {
    expect(() => CreateTransactionSchema.parse({ ...base, amount: '12.345' })).toThrow();
  });

  it('rejects invalid date string', () => {
    expect(() => CreateTransactionSchema.parse({ ...base, date: 'not-a-date' })).toThrow();
  });

  it('rejects wrong type', () => {
    expect(() =>
      CreateTransactionSchema.parse({ ...base, type: 'TRANSFER' as unknown as 'EXPENSE' }),
    ).toThrow();
  });

  it('rejects negative non-money strings', () => {
    expect(() => CreateTransactionSchema.parse({ ...base, amount: 'abc' })).toThrow();
  });

  it('allows zero amount', () => {
    const parsed = CreateTransactionSchema.parse({ ...base, amount: '0' });
    expect(parsed.amount).toBe('0');
  });

  it('allows negative amount (correction)', () => {
    const parsed = CreateTransactionSchema.parse({ ...base, amount: '-100.00' });
    expect(parsed.amount).toBe('-100.00');
  });

  it('accepts an allowed manual kind matching the type', () => {
    const parsed = CreateTransactionSchema.parse({ ...base, type: 'EXPENSE', kind: 'TAX' });
    expect(parsed.kind).toBe('TAX');
  });

  it('accepts CAPITAL_IN for INCOME', () => {
    const parsed = CreateTransactionSchema.parse({ ...base, type: 'INCOME', kind: 'CAPITAL_IN' });
    expect(parsed.kind).toBe('CAPITAL_IN');
  });

  it('defaults kind to undefined when omitted (БД-дефолт OTHER)', () => {
    expect(CreateTransactionSchema.parse(base).kind).toBeUndefined();
  });

  it('rejects a system kind (COGS) — заводится только доменом', () => {
    expect(() =>
      CreateTransactionSchema.parse({ ...base, type: 'EXPENSE', kind: 'COGS' }),
    ).toThrow();
  });

  it('rejects ORDER_PAYMENT — системный kind', () => {
    expect(() =>
      CreateTransactionSchema.parse({ ...base, type: 'INCOME', kind: 'ORDER_PAYMENT' }),
    ).toThrow();
  });

  it('rejects kind↔type mismatch (CAPITAL_IN при EXPENSE)', () => {
    expect(() =>
      CreateTransactionSchema.parse({ ...base, type: 'EXPENSE', kind: 'CAPITAL_IN' }),
    ).toThrow();
  });

  it('rejects kind↔type mismatch (TAX при INCOME)', () => {
    expect(() =>
      CreateTransactionSchema.parse({ ...base, type: 'INCOME', kind: 'TAX' }),
    ).toThrow();
  });
});

describe('UpdateTransactionSchema', () => {
  it('allows empty object (no updates)', () => {
    expect(() => UpdateTransactionSchema.parse({})).not.toThrow();
  });

  it('allows explicit null for categoryId (clear)', () => {
    const parsed = UpdateTransactionSchema.parse({ categoryId: null });
    expect(parsed.categoryId).toBeNull();
  });

  it('allows explicit null for description', () => {
    const parsed = UpdateTransactionSchema.parse({ description: null });
    expect(parsed.description).toBeNull();
  });
});

describe('ListTransactionsQuerySchema', () => {
  it('defaults limit to 50', () => {
    const parsed = ListTransactionsQuerySchema.parse({});
    expect(parsed.limit).toBe(50);
  });

  it('caps limit at 100', () => {
    expect(() => ListTransactionsQuerySchema.parse({ limit: 200 })).toThrow();
  });

  it('coerces string limit to number', () => {
    const parsed = ListTransactionsQuerySchema.parse({ limit: '25' });
    expect(parsed.limit).toBe(25);
  });

  it('accepts all filter fields', () => {
    const parsed = ListTransactionsQuerySchema.parse({
      from: '2026-01-01T00:00:00Z',
      to: '2026-12-31T23:59:59Z',
      accountId: 'cuid_a',
      categoryId: 'cuid_c',
      counterpartyId: 'cuid_cp',
      type: 'INCOME',
      minAmount: '100.00',
      maxAmount: '10000.00',
      search: 'обед',
      cursor: 'cuid_tx',
      limit: 50,
    });
    expect(parsed.type).toBe('INCOME');
    expect(parsed.minAmount).toBe('100.00');
  });
});
