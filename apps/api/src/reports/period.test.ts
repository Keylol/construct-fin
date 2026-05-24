import { describe, expect, it } from 'vitest';
import {
  enumerateMonths,
  enumerateQuarters,
  resolveComparison,
  resolvePeriod,
  resolvePreset,
} from './period';

const NOW = new Date('2026-05-15T12:00:00');

describe('resolvePreset', () => {
  it('this-month: 1st of month → now', () => {
    const p = resolvePreset('this-month', NOW);
    expect(p.from.getMonth()).toBe(4);
    expect(p.from.getDate()).toBe(1);
    expect(p.from.getHours()).toBe(0);
    expect(p.to.getDate()).toBe(15);
  });

  it('prev-month: full April 2026', () => {
    const p = resolvePreset('prev-month', NOW);
    expect(p.from.getFullYear()).toBe(2026);
    expect(p.from.getMonth()).toBe(3);
    expect(p.from.getDate()).toBe(1);
    expect(p.to.getMonth()).toBe(3);
    expect(p.to.getDate()).toBe(30);
  });

  it('this-quarter: Q2 2026 starts Apr 1', () => {
    const p = resolvePreset('this-quarter', NOW);
    expect(p.from.getMonth()).toBe(3);
    expect(p.from.getDate()).toBe(1);
  });

  it('prev-quarter rolling over the year boundary', () => {
    const jan = new Date('2026-01-10T12:00:00');
    const p = resolvePreset('prev-quarter', jan);
    expect(p.from.getFullYear()).toBe(2025);
    expect(p.from.getMonth()).toBe(9);
    expect(p.to.getMonth()).toBe(11);
  });

  it('ytd: from Jan 1 same year', () => {
    const p = resolvePreset('ytd', NOW);
    expect(p.from.getMonth()).toBe(0);
    expect(p.from.getDate()).toBe(1);
  });

  it('prev-year: full last year', () => {
    const p = resolvePreset('prev-year', NOW);
    expect(p.from.getFullYear()).toBe(2025);
    expect(p.to.getFullYear()).toBe(2025);
    expect(p.to.getMonth()).toBe(11);
    expect(p.to.getDate()).toBe(31);
  });

  it('last-30d: 30 day window ending today', () => {
    const p = resolvePreset('last-30d', NOW);
    const days = Math.round((p.to.getTime() - p.from.getTime()) / 86_400_000);
    expect(days).toBe(30);
  });
});

describe('resolvePeriod', () => {
  it('uses custom from/to when no preset', () => {
    const p = resolvePeriod({ from: '2026-01-15', to: '2026-02-15' }, NOW);
    expect(p.from.getMonth()).toBe(0);
    expect(p.to.getMonth()).toBe(1);
  });

  it('falls back to this-month when nothing supplied', () => {
    const p = resolvePeriod({}, NOW);
    expect(p.from.getMonth()).toBe(4);
  });
});

describe('resolveComparison', () => {
  const primary = resolvePreset('this-month', NOW);

  it('returns null for mode=none', () => {
    expect(resolveComparison(primary, { mode: 'none' })).toBeNull();
  });

  it('prev: equal-length range ending before primary.from', () => {
    const c = resolveComparison(primary, { mode: 'prev' });
    expect(c).not.toBeNull();
    expect(c!.to.getTime()).toBe(primary.from.getTime() - 1);
  });

  it('yoy: same window shifted by 1 year', () => {
    const c = resolveComparison(primary, { mode: 'yoy' });
    expect(c).not.toBeNull();
    expect(c!.from.getFullYear()).toBe(primary.from.getFullYear() - 1);
    expect(c!.to.getFullYear()).toBe(primary.to.getFullYear() - 1);
  });

  it('custom requires both from and to', () => {
    expect(resolveComparison(primary, { mode: 'custom' })).toBeNull();
    const c = resolveComparison(primary, { mode: 'custom', from: '2025-01-01', to: '2025-01-31' });
    expect(c).not.toBeNull();
  });
});

describe('enumerateMonths', () => {
  it('lists 3 months for Jan-Mar window', () => {
    const months = enumerateMonths({
      from: new Date(2026, 0, 1),
      to: new Date(2026, 2, 31, 23, 59, 59),
    });
    expect(months).toHaveLength(3);
    expect(months[0]!.label).toBe('2026-01');
    expect(months[2]!.label).toBe('2026-03');
  });

  it('caps edges to period bounds', () => {
    const months = enumerateMonths({
      from: new Date(2026, 0, 15),
      to: new Date(2026, 1, 10, 23, 59, 59),
    });
    expect(months).toHaveLength(2);
    expect(months[0]!.from.getDate()).toBe(15);
    expect(months[1]!.to.getDate()).toBe(10);
  });

  it('crosses year boundary', () => {
    const months = enumerateMonths({
      from: new Date(2025, 10, 1),
      to: new Date(2026, 1, 28, 23, 59, 59),
    });
    expect(months.map((m) => m.label)).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
  });
});

describe('enumerateQuarters', () => {
  it('Q1+Q2 2026', () => {
    const qs = enumerateQuarters({
      from: new Date(2026, 0, 1),
      to: new Date(2026, 5, 30, 23, 59, 59),
    });
    expect(qs.map((q) => q.label)).toEqual(['2026-Q1', '2026-Q2']);
  });
});
