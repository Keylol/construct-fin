import { describe, expect, it } from 'vitest';
import {
  computeNextRunAt,
  enumerateOccurrences,
  firstOccurrenceAfter,
  nextOccurrence,
  type ScheduleInput,
} from './recurring.engine';

const dailySchedule = (overrides: Partial<ScheduleInput> = {}): ScheduleInput => ({
  frequency: 'DAILY',
  interval: 1,
  startDate: new Date('2026-05-01T09:00:00Z'),
  endDate: null,
  dayOfMonth: null,
  dayOfWeek: null,
  ...overrides,
});

describe('nextOccurrence', () => {
  it('daily +1 day', () => {
    const next = nextOccurrence(dailySchedule(), new Date('2026-05-10T09:00:00Z'));
    expect(next.toISOString()).toBe('2026-05-11T09:00:00.000Z');
  });
  it('daily interval=3', () => {
    const next = nextOccurrence(dailySchedule({ interval: 3 }), new Date('2026-05-10T09:00:00Z'));
    expect(next.toISOString()).toBe('2026-05-13T09:00:00.000Z');
  });
  it('weekly +7 days', () => {
    const next = nextOccurrence(
      dailySchedule({ frequency: 'WEEKLY' }),
      new Date('2026-05-10T09:00:00Z'),
    );
    expect(next.toISOString()).toBe('2026-05-17T09:00:00.000Z');
  });
  it('monthly clamps to last day for short months', () => {
    const next = nextOccurrence(
      dailySchedule({ frequency: 'MONTHLY', dayOfMonth: 31 }),
      new Date('2026-01-31T09:00:00Z'),
    );
    // Feb 2026 has 28 days
    expect(next.toISOString()).toBe('2026-02-28T09:00:00.000Z');
  });
  it('yearly +1 year', () => {
    const next = nextOccurrence(
      dailySchedule({ frequency: 'YEARLY' }),
      new Date('2026-05-10T09:00:00Z'),
    );
    expect(next.toISOString()).toBe('2027-05-10T09:00:00.000Z');
  });
});

describe('firstOccurrenceAfter', () => {
  it('returns startDate if floor < startDate', () => {
    const rule = dailySchedule();
    const r = firstOccurrenceAfter(rule, new Date('2026-04-01T00:00:00Z'));
    expect(r.toISOString()).toBe('2026-05-01T09:00:00.000Z');
  });
  it('walks forward past floor', () => {
    const rule = dailySchedule();
    const r = firstOccurrenceAfter(rule, new Date('2026-05-15T00:00:00Z'));
    expect(r.toISOString()).toBe('2026-05-15T09:00:00.000Z');
  });
});

describe('enumerateOccurrences', () => {
  it('catch-up: rule started 5 days ago, no lastRunAt → 5 occurrences', () => {
    const now = new Date('2026-05-06T09:00:00Z');
    const rule = dailySchedule({ startDate: new Date('2026-05-01T09:00:00Z') });
    const list = enumerateOccurrences(rule, { lastRunAt: null, now });
    expect(list.length).toBe(6);
    expect(list[0]?.toISOString()).toBe('2026-05-01T09:00:00.000Z');
    expect(list[5]?.toISOString()).toBe('2026-05-06T09:00:00.000Z');
  });

  it('catch-up limited to 30 days', () => {
    const now = new Date('2026-06-30T09:00:00Z');
    const rule = dailySchedule({ startDate: new Date('2026-01-01T09:00:00Z') });
    const list = enumerateOccurrences(rule, { lastRunAt: null, now });
    // floor = now - 30 days = 2026-05-31; daily from there to now (inclusive) = 30 days
    expect(list.length).toBeLessThanOrEqual(31);
    expect(list[0]?.getTime()).toBeGreaterThanOrEqual(
      new Date('2026-05-31T00:00:00Z').getTime(),
    );
  });

  it('lastRunAt fences out already-processed days', () => {
    const now = new Date('2026-05-10T09:00:00Z');
    const rule = dailySchedule({ startDate: new Date('2026-05-01T09:00:00Z') });
    const list = enumerateOccurrences(rule, {
      lastRunAt: new Date('2026-05-08T09:00:00Z'),
      now,
    });
    expect(list.length).toBe(2);
    expect(list[0]?.toISOString()).toBe('2026-05-09T09:00:00.000Z');
    expect(list[1]?.toISOString()).toBe('2026-05-10T09:00:00.000Z');
  });

  it('respects endDate', () => {
    const now = new Date('2026-05-20T09:00:00Z');
    const rule = dailySchedule({
      startDate: new Date('2026-05-01T09:00:00Z'),
      endDate: new Date('2026-05-03T09:00:00Z'),
    });
    const list = enumerateOccurrences(rule, { lastRunAt: null, now });
    expect(list.length).toBe(3);
    expect(list[2]?.toISOString()).toBe('2026-05-03T09:00:00.000Z');
  });

  it('idempotent: empty result when nothing due', () => {
    const now = new Date('2026-05-10T09:00:00Z');
    const rule = dailySchedule({ startDate: new Date('2026-06-01T09:00:00Z') });
    const list = enumerateOccurrences(rule, { lastRunAt: null, now });
    expect(list.length).toBe(0);
  });
});

describe('computeNextRunAt', () => {
  it('returns startDate if in future', () => {
    const r = computeNextRunAt(
      dailySchedule({ startDate: new Date('2026-12-01T09:00:00Z') }),
      new Date('2026-05-01T00:00:00Z'),
    );
    expect(r?.toISOString()).toBe('2026-12-01T09:00:00.000Z');
  });
  it('returns next future occurrence past now', () => {
    const r = computeNextRunAt(
      dailySchedule({ startDate: new Date('2026-05-01T09:00:00Z') }),
      new Date('2026-05-10T12:00:00Z'),
    );
    expect(r?.toISOString()).toBe('2026-05-11T09:00:00.000Z');
  });
  it('returns null past endDate', () => {
    const r = computeNextRunAt(
      dailySchedule({
        startDate: new Date('2026-05-01T09:00:00Z'),
        endDate: new Date('2026-05-05T09:00:00Z'),
      }),
      new Date('2026-05-10T00:00:00Z'),
    );
    expect(r).toBeNull();
  });
});
