import { describe, it, expect } from 'vitest';
import { recurrenceOccurrences, type RecurrenceRule } from './recurrence';
import { businessInstant, businessDayParts } from '../reports/period';

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
function weekdayOf(d: Date): number {
  const p = businessDayParts(d);
  return new Date(Date.UTC(p.y, p.mo, p.d)).getUTCDay();
}

describe('recurrenceOccurrences — MONTHLY', () => {
  it('число месяца в окне из 3 месяцев → 3 даты 15-го', () => {
    const rule: RecurrenceRule = {
      cadence: 'MONTHLY',
      dayOfMonth: 15,
      weekday: null,
      startDate: new Date('2026-01-01T00:00:00Z'),
      endDate: null,
    };
    const occ = recurrenceOccurrences(rule, businessInstant(2026, 6, 1, 0), businessInstant(2026, 8, 28, 23));
    expect(occ.map(isoDay)).toEqual(['2026-07-15', '2026-08-15', '2026-09-15']);
  });

  it('день 31 клампится к длине месяца (фев=28, апр=30)', () => {
    const rule: RecurrenceRule = {
      cadence: 'MONTHLY',
      dayOfMonth: 31,
      weekday: null,
      startDate: new Date('2026-01-01T00:00:00Z'),
      endDate: null,
    };
    const occ = recurrenceOccurrences(rule, businessInstant(2026, 0, 1, 0), businessInstant(2026, 3, 30, 23));
    expect(occ.map(isoDay)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  });

  it('startDate/endDate правила ограничивают вхождения', () => {
    const rule: RecurrenceRule = {
      cadence: 'MONTHLY',
      dayOfMonth: 10,
      weekday: null,
      startDate: new Date('2026-03-01T00:00:00Z'),
      endDate: new Date('2026-05-31T00:00:00Z'),
    };
    const occ = recurrenceOccurrences(rule, businessInstant(2026, 0, 1, 0), businessInstant(2026, 11, 31, 23));
    expect(occ.map(isoDay)).toEqual(['2026-03-10', '2026-04-10', '2026-05-10']);
  });

  it('вхождения канонично на полдень бизнес-времени (07:00Z для UTC+5)', () => {
    const rule: RecurrenceRule = {
      cadence: 'MONTHLY',
      dayOfMonth: 15,
      weekday: null,
      startDate: new Date('2026-01-01T00:00:00Z'),
      endDate: null,
    };
    const occ = recurrenceOccurrences(rule, businessInstant(2026, 6, 1, 0), businessInstant(2026, 6, 20, 23));
    expect(occ[0]!.toISOString()).toBe('2026-07-15T07:00:00.000Z');
  });

  it('нет dayOfMonth или он вне 1..31 → пусто', () => {
    const base = {
      cadence: 'MONTHLY' as const,
      weekday: null,
      startDate: new Date('2026-01-01T00:00:00Z'),
      endDate: null,
    };
    const w0 = businessInstant(2026, 0, 1, 0);
    const w1 = businessInstant(2026, 11, 31, 23);
    expect(recurrenceOccurrences({ ...base, dayOfMonth: null }, w0, w1)).toEqual([]);
    expect(recurrenceOccurrences({ ...base, dayOfMonth: 0 }, w0, w1)).toEqual([]);
    expect(recurrenceOccurrences({ ...base, dayOfMonth: 32 }, w0, w1)).toEqual([]);
  });
});

describe('recurrenceOccurrences — WEEKLY', () => {
  it('день недели в окне 21 день → ровно 3 вхождения нужного дня, по возрастанию', () => {
    const weekday = 1; // понедельник
    const rule: RecurrenceRule = {
      cadence: 'WEEKLY',
      dayOfMonth: null,
      weekday,
      startDate: new Date('2026-07-01T00:00:00Z'),
      endDate: null,
    };
    const occ = recurrenceOccurrences(rule, businessInstant(2026, 6, 6, 0), businessInstant(2026, 6, 26, 23));
    expect(occ.length).toBe(3);
    occ.forEach((d) => expect(weekdayOf(d)).toBe(weekday));
    const times = occ.map((o) => o.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('нет weekday или вне 0..6 → пусто', () => {
    const base = {
      cadence: 'WEEKLY' as const,
      dayOfMonth: null,
      startDate: new Date('2026-01-01T00:00:00Z'),
      endDate: null,
    };
    const w0 = businessInstant(2026, 0, 1, 0);
    const w1 = businessInstant(2026, 1, 1, 23);
    expect(recurrenceOccurrences({ ...base, weekday: null }, w0, w1)).toEqual([]);
    expect(recurrenceOccurrences({ ...base, weekday: 7 }, w0, w1)).toEqual([]);
  });
});

describe('recurrenceOccurrences — окно', () => {
  it('инвертированное окно (start > end) → пусто', () => {
    const rule: RecurrenceRule = {
      cadence: 'MONTHLY',
      dayOfMonth: 1,
      weekday: null,
      startDate: new Date('2026-01-01T00:00:00Z'),
      endDate: null,
    };
    expect(recurrenceOccurrences(rule, businessInstant(2026, 5, 1, 0), businessInstant(2026, 0, 1, 0))).toEqual([]);
  });
});
