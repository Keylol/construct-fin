import { describe, expect, it } from 'vitest';
import { CreateCategorySchema, UpdateCategorySchema } from './category.dto';

describe('CreateCategorySchema — bucket', () => {
  const base = { name: 'Реклама', kind: 'EXPENSE' as const };

  it('accepts a category without bucket (БД-дефолт OTHER)', () => {
    const parsed = CreateCategorySchema.parse(base);
    expect(parsed.bucket).toBeUndefined();
  });

  it.each(['REVENUE', 'COGS', 'PURCHASES', 'FIXED', 'VARIABLE', 'TAX', 'CAPITAL', 'OTHER'] as const)(
    'accepts bucket %s',
    (bucket) => {
      const parsed = CreateCategorySchema.parse({ ...base, bucket });
      expect(parsed.bucket).toBe(bucket);
    },
  );

  it('rejects an unknown bucket', () => {
    expect(() => CreateCategorySchema.parse({ ...base, bucket: 'GARBAGE' })).toThrow();
  });
});

describe('UpdateCategorySchema — bucket', () => {
  it('accepts a partial update with only bucket', () => {
    const parsed = UpdateCategorySchema.parse({ bucket: 'FIXED' });
    expect(parsed.bucket).toBe('FIXED');
  });

  it('rejects an unknown bucket', () => {
    expect(() => UpdateCategorySchema.parse({ bucket: 'NOPE' })).toThrow();
  });
});
