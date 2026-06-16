import { describe, it, expect } from 'vitest';
import { rangeFor, toLocalDateInput, fromLocalDateInput } from './periods';

/**
 * E4 (Трек E): юниты на рабочие периоды — TZ-устойчиво (проверяем локальные
 * Y/M/D через toLocalDateInput от распарсенного ISO, а не точную ISO-строку).
 * now фиксирован: вторник 16 июня 2026, локальное время.
 */
const NOW = new Date(2026, 5, 16, 14, 30, 0); // мес=5 → июнь; вт
const localYMD = (iso: string) => toLocalDateInput(new Date(iso));

describe('rangeFor', () => {
  it("'all' → пустой диапазон", () => {
    expect(rangeFor('all', NOW)).toEqual({});
  });

  it("'today' → начало..конец того же дня", () => {
    const r = rangeFor('today', NOW);
    expect(localYMD(r.from!)).toBe('2026-06-16');
    expect(localYMD(r.to!)).toBe('2026-06-16');
  });

  it("'week' → с понедельника (16 июня вт → пн 15 июня)", () => {
    const r = rangeFor('week', NOW);
    expect(localYMD(r.from!)).toBe('2026-06-15');
    expect(localYMD(r.to!)).toBe('2026-06-16');
  });

  it("'month' → с 1-го числа", () => {
    expect(localYMD(rangeFor('month', NOW).from!)).toBe('2026-06-01');
  });

  it("'quarter' → с начала квартала (июнь → 1 апреля)", () => {
    expect(localYMD(rangeFor('quarter', NOW).from!)).toBe('2026-04-01');
  });

  it("'year' → с 1 января", () => {
    expect(localYMD(rangeFor('year', NOW).from!)).toBe('2026-01-01');
  });
});

describe('toLocalDateInput / fromLocalDateInput', () => {
  it('toLocalDateInput даёт YYYY-MM-DD в локали', () => {
    expect(toLocalDateInput(new Date(2026, 0, 5))).toBe('2026-01-05');
  });

  it('roundtrip сохраняет дату (через полдень, без сдвига дня)', () => {
    const iso = fromLocalDateInput('2026-03-09');
    expect(toLocalDateInput(new Date(iso))).toBe('2026-03-09');
  });
});
