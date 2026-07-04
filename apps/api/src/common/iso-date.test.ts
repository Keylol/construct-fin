import { describe, it, expect } from 'vitest';
import { isoDate } from './iso-date';

describe('IJ7: строгий isoDate', () => {
  it('принимает валидные календарные даты', () => {
    for (const s of ['2026-05-01', '2024-02-29', '2026-12-31', '2026-05-01T12:00:00.000Z']) {
      expect(isoDate.safeParse(s).success).toBe(true);
    }
  });

  it('отвергает несуществующие календарные даты (перекат JS)', () => {
    // Date.parse их не отбраковывает — тихо перекатывает в следующий месяц.
    for (const s of ['2026-02-31', '2026-02-30', '2026-04-31', '2026-13-01', '2026-00-10', '2023-02-29']) {
      expect(isoDate.safeParse(s).success).toBe(false);
    }
  });

  it('отвергает мусор и пустое', () => {
    for (const s of ['', 'not-a-date', '2026/05/01', '05-01-2026']) {
      expect(isoDate.safeParse(s).success).toBe(false);
    }
  });
});
