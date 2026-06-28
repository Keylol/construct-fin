import { describe, expect, it } from 'vitest';
import { PnlQuerySchema } from './reports.dto';

/**
 * isoDate ужесточён (#27): регэксп ограничивает месяц 01-12 и день 01-31, а
 * .refine отбраковывает несуществующие календарные даты. Проверяем через
 * PnlQuerySchema.from (одно из мест переиспользования isoDate).
 */
describe('isoDate (через PnlQuerySchema.from)', () => {
  it('принимает корректные даты и дата-время', () => {
    expect(PnlQuerySchema.parse({ from: '2026-01-31' }).from).toBe('2026-01-31');
    expect(PnlQuerySchema.parse({ from: '2026-12-01T10:00:00.000Z' }).from).toBe(
      '2026-12-01T10:00:00.000Z',
    );
  });

  it('отбраковывает несуществующий месяц (13) и день (45)', () => {
    expect(() => PnlQuerySchema.parse({ from: '2026-13-45' })).toThrow();
    expect(() => PnlQuerySchema.parse({ from: '2026-00-10' })).toThrow();
    expect(() => PnlQuerySchema.parse({ from: '2026-01-32' })).toThrow();
    expect(() => PnlQuerySchema.parse({ from: '2026-01-00' })).toThrow();
  });

  it('отбраковывает несуществующую календарную дату (30 февраля, 31 апреля)', () => {
    expect(() => PnlQuerySchema.parse({ from: '2026-02-30' })).toThrow();
    expect(() => PnlQuerySchema.parse({ from: '2026-04-31' })).toThrow();
  });

  it('принимает 29 февраля в високосном и отбраковывает в невисокосном году', () => {
    expect(PnlQuerySchema.parse({ from: '2024-02-29' }).from).toBe('2024-02-29');
    expect(() => PnlQuerySchema.parse({ from: '2026-02-29' })).toThrow();
  });
});
