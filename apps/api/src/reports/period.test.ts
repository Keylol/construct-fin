import { describe, expect, it } from 'vitest';
import {
  enumerateMonths,
  enumerateQuarters,
  resolveComparison,
  resolvePeriod,
  resolvePreset,
} from './period';

/**
 * Границы периодов считаются в фиксированном поясе UTC+5 (R5), поэтому ассерты
 * TZ-НЕЗАВИСИМЫ: сравниваем точные UTC-инстанты (toISOString), а не локальные
 * getMonth/getDate (которые зависели бы от пояса CI). Начало месяца в UTC+5 =
 * 00:00 UTC+5 = 19:00 UTC предыдущих суток.
 */
const NOW = new Date('2026-05-15T12:00:00.000Z'); // в UTC+5 — 15 мая 17:00, середина мая

describe('resolvePreset (границы в UTC+5)', () => {
  it('this-month: с 1-го числа (00:00 UTC+5) по now', () => {
    const p = resolvePreset('this-month', NOW);
    expect(p.from.toISOString()).toBe('2026-04-30T19:00:00.000Z'); // 1 мая 00:00 UTC+5
    expect(p.to.toISOString()).toBe('2026-05-15T18:59:59.999Z'); // 15 мая 23:59:59.999 UTC+5
  });

  it('prev-month: весь апрель 2026 в UTC+5', () => {
    const p = resolvePreset('prev-month', NOW);
    expect(p.from.toISOString()).toBe('2026-03-31T19:00:00.000Z'); // 1 апр 00:00 UTC+5
    expect(p.to.toISOString()).toBe('2026-04-30T18:59:59.999Z'); // 30 апр 23:59:59.999 UTC+5
  });

  it('this-quarter: Q2 2026 c 1 апреля (UTC+5)', () => {
    const p = resolvePreset('this-quarter', NOW);
    expect(p.from.toISOString()).toBe('2026-03-31T19:00:00.000Z');
  });

  it('prev-quarter через границу года: Q4 2025', () => {
    const p = resolvePreset('prev-quarter', new Date('2026-01-10T12:00:00.000Z'));
    expect(p.from.toISOString()).toBe('2025-09-30T19:00:00.000Z'); // 1 окт 2025 00:00 UTC+5
    expect(p.to.toISOString()).toBe('2025-12-31T18:59:59.999Z'); // 31 дек 2025 23:59:59.999 UTC+5
  });

  it('ytd: с 1 января текущего года (UTC+5)', () => {
    const p = resolvePreset('ytd', NOW);
    expect(p.from.toISOString()).toBe('2025-12-31T19:00:00.000Z'); // 1 янв 2026 00:00 UTC+5
  });

  it('prev-year: весь 2025 в UTC+5', () => {
    const p = resolvePreset('prev-year', NOW);
    expect(p.from.toISOString()).toBe('2024-12-31T19:00:00.000Z');
    expect(p.to.toISOString()).toBe('2025-12-31T18:59:59.999Z');
  });

  it('last-30d: окно длиной 30 дней (TZ-независимо)', () => {
    const p = resolvePreset('last-30d', NOW);
    const days = Math.round((p.to.getTime() - p.from.getTime()) / 86_400_000);
    expect(days).toBe(30);
  });
});

describe('resolvePeriod', () => {
  it('кастомный from/to → startOfDay/endOfDay в UTC+5', () => {
    const p = resolvePeriod({ from: '2026-01-15', to: '2026-02-15' }, NOW);
    expect(p.from.toISOString()).toBe('2026-01-14T19:00:00.000Z'); // 15 янв 00:00 UTC+5
    expect(p.to.toISOString()).toBe('2026-02-15T18:59:59.999Z'); // 15 фев 23:59:59.999 UTC+5
  });

  it('без параметров → this-month', () => {
    const p = resolvePeriod({}, NOW);
    expect(p.from.toISOString()).toBe('2026-04-30T19:00:00.000Z');
  });

  it('M2: инвертированный диапазон (from > to) → ошибка', () => {
    expect(() => resolvePeriod({ from: '2026-02-15', to: '2026-01-15' }, NOW)).toThrow();
  });
});

describe('resolveComparison', () => {
  const primary = resolvePreset('this-month', NOW);

  it('mode=none → null', () => {
    expect(resolveComparison(primary, { mode: 'none' })).toBeNull();
  });

  it('prev БЕЗ пресета → диапазон той же длины прямо перед primary', () => {
    const c = resolveComparison(primary, { mode: 'prev' });
    expect(c).not.toBeNull();
    expect(c!.to.getTime()).toBe(primary.from.getTime() - 1);
  });

  it('M1: prev С пресетом this-month → ПРЕДЫДУЩИЙ КАЛЕНДАРНЫЙ месяц (весь апрель)', () => {
    const c = resolveComparison(primary, { mode: 'prev', preset: 'this-month' }, NOW);
    const prevMonth = resolvePreset('prev-month', NOW);
    expect(c!.from.toISOString()).toBe(prevMonth.from.toISOString()); // 1 апр
    expect(c!.to.toISOString()).toBe(prevMonth.to.toISOString()); // 30 апр (полный месяц, не «N дней до»)
  });

  it('yoy: то же окно на год назад (1 мая 2025 в UTC+5)', () => {
    const c = resolveComparison(primary, { mode: 'yoy' });
    expect(c!.from.toISOString()).toBe('2025-04-30T19:00:00.000Z');
  });

  it('custom требует обе границы', () => {
    expect(resolveComparison(primary, { mode: 'custom' })).toBeNull();
    expect(resolveComparison(primary, { mode: 'custom', from: '2025-01-01', to: '2025-01-31' })).not.toBeNull();
  });
});

describe('enumerateMonths', () => {
  it('3 месяца для окна янв–мар', () => {
    const months = enumerateMonths(resolvePeriod({ from: '2026-01-01', to: '2026-03-31' }, NOW));
    expect(months.map((m) => m.label)).toEqual(['2026-01', '2026-02', '2026-03']);
  });

  it('обрезает края по границам периода', () => {
    const period = resolvePeriod({ from: '2026-01-15', to: '2026-02-10' }, NOW);
    const months = enumerateMonths(period);
    expect(months).toHaveLength(2);
    expect(months[0]!.from.toISOString()).toBe(period.from.toISOString()); // обрезано до 15 янв
    expect(months[1]!.to.toISOString()).toBe(period.to.toISOString()); // обрезано до 10 фев
  });

  it('через границу года', () => {
    const months = enumerateMonths(resolvePeriod({ from: '2025-11-01', to: '2026-02-28' }, NOW));
    expect(months.map((m) => m.label)).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
  });
});

describe('enumerateQuarters', () => {
  it('Q1+Q2 2026', () => {
    const qs = enumerateQuarters(resolvePeriod({ from: '2026-01-01', to: '2026-06-30' }, NOW));
    expect(qs.map((q) => q.label)).toEqual(['2026-Q1', '2026-Q2']);
  });
});
