import { describe, it, expect } from 'vitest';
import { rangeFor, toLocalDateInput, fromLocalDateInput } from './periods';

/**
 * E4 (Трек E) + M4: юниты на рабочие периоды. rangeFor считает границы в
 * ФИКСИРОВАННОМ поясе бизнеса UTC+5 (инвариант R5, как на бэке), а НЕ в локальном
 * поясе. Тест TZ-независим: `now` задан абсолютным инстантом с явным +05:00, а
 * границы проверяем в UTC+5 (tz5YMD / точное время суток), а НЕ через локальный
 * toLocalDateInput — иначе результат зависел бы от TZ раннера (CI ≠ dev).
 * now: вторник 16 июня 2026, 14:30 по UTC+5.
 */
const NOW = new Date('2026-06-16T14:30:00+05:00');
const OFFSET_MS = 5 * 60 * 60_000;
const pad = (n: number) => String(n).padStart(2, '0');
/** Y/M/D момента (по ISO) в поясе бизнеса UTC+5. */
const tz5YMD = (iso: string) => {
  const d = new Date(new Date(iso).getTime() + OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};
/** HH:MM:SS.mmm момента (по ISO) в поясе бизнеса UTC+5. */
const tz5Time = (iso: string) => {
  const d = new Date(new Date(iso).getTime() + OFFSET_MS);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(
    d.getUTCSeconds(),
  )}.${String(d.getUTCMilliseconds()).padStart(3, '0')}`;
};

describe('rangeFor (границы в фиксированном UTC+5)', () => {
  it("'all' → пустой диапазон", () => {
    expect(rangeFor('all', NOW)).toEqual({});
  });

  it("'today' → начало..конец того же дня в UTC+5", () => {
    const r = rangeFor('today', NOW);
    expect(tz5YMD(r.from!)).toBe('2026-06-16');
    expect(tz5Time(r.from!)).toBe('00:00:00.000');
    expect(tz5YMD(r.to!)).toBe('2026-06-16');
    expect(tz5Time(r.to!)).toBe('23:59:59.999');
  });

  it("'week' → с понедельника (16 июня вт → пн 15 июня) в UTC+5", () => {
    const r = rangeFor('week', NOW);
    expect(tz5YMD(r.from!)).toBe('2026-06-15');
    expect(tz5Time(r.from!)).toBe('00:00:00.000');
    expect(tz5YMD(r.to!)).toBe('2026-06-16');
  });

  it("'month' → с 1-го числа в UTC+5", () => {
    const r = rangeFor('month', NOW);
    expect(tz5YMD(r.from!)).toBe('2026-06-01');
    expect(tz5Time(r.from!)).toBe('00:00:00.000');
  });

  it("'quarter' → с начала квартала (июнь → 1 апреля) в UTC+5", () => {
    expect(tz5YMD(rangeFor('quarter', NOW).from!)).toBe('2026-04-01');
  });

  it("'year' → с 1 января в UTC+5", () => {
    expect(tz5YMD(rangeFor('year', NOW).from!)).toBe('2026-01-01');
  });

  it('границы совпадают независимо от того, поздний вечер это или утро (стык суток)', () => {
    // 23:30 UTC+5 30 июня: в локальном поясе западнее это уже было бы 1 июля и
    // 'today' уехал бы в другой день. В UTC+5 — всё ещё 30 июня.
    const late = new Date('2026-06-30T23:30:00+05:00');
    expect(tz5YMD(rangeFor('today', late).from!)).toBe('2026-06-30');
    expect(tz5YMD(rangeFor('month', late).from!)).toBe('2026-06-01');
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
