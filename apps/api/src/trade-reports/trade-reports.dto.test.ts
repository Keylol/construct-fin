import { describe, expect, it } from 'vitest';
import { MarginQuerySchema } from './trade-reports.dto';

/**
 * #26: частично заданный период маржи (ровно одна из from/to без preset) — это
 * ошибка ввода, а не «вся история» по-тихому. DTO отклоняет такой запрос.
 */
describe('MarginQuerySchema — период', () => {
  it('принимает пустой запрос (вся история)', () => {
    expect(MarginQuerySchema.parse({})).toEqual({});
  });

  it('принимает обе границы from+to', () => {
    const q = MarginQuerySchema.parse({ from: '2026-01-01', to: '2026-01-31' });
    expect(q.from).toBe('2026-01-01');
    expect(q.to).toBe('2026-01-31');
  });

  it('принимает preset', () => {
    expect(MarginQuerySchema.parse({ preset: 'this-month' }).preset).toBe('this-month');
  });

  it('отклоняет только from (без to и без preset)', () => {
    expect(() => MarginQuerySchema.parse({ from: '2026-01-01' })).toThrow();
  });

  it('отклоняет только to (без from и без preset)', () => {
    expect(() => MarginQuerySchema.parse({ to: '2026-01-31' })).toThrow();
  });

  it('preset имеет приоритет: частичный from при заданном preset допустим', () => {
    const q = MarginQuerySchema.parse({ preset: 'this-month', from: '2026-01-01' });
    expect(q.preset).toBe('this-month');
  });
});
