import { describe, it, expect } from 'vitest';
import { assertBucketMatchesKind } from './category.service';

/**
 * Пары «вид статьи ↔ группа отчёта». Ошибка здесь тихо искажает прибыль, поэтому
 * фиксируем и запреты, и разрешения, из-за которых их меняли.
 */
describe('assertBucketMatchesKind', () => {
  it('доход может быть возвратом от поставщика (группа «Закупки»)', () => {
    expect(() => assertBucketMatchesKind('INCOME', 'PURCHASES')).not.toThrow();
  });

  it('доход по-прежнему не может быть себестоимостью или постоянным расходом', () => {
    expect(() => assertBucketMatchesKind('INCOME', 'COGS')).toThrow();
    expect(() => assertBucketMatchesKind('INCOME', 'FIXED')).toThrow();
    expect(() => assertBucketMatchesKind('INCOME', 'VARIABLE')).toThrow();
    expect(() => assertBucketMatchesKind('INCOME', 'TAX')).toThrow();
  });

  it('расход может быть возвратом выручки клиенту (группа «Выручка»)', () => {
    expect(() => assertBucketMatchesKind('EXPENSE', 'REVENUE')).not.toThrow();
  });

  it('группа не задана — проверка пропускается', () => {
    expect(() => assertBucketMatchesKind('INCOME', undefined)).not.toThrow();
  });
});
