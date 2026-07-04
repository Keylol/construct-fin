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

  it('IJ12: диапазон шире 5 лет → ошибка', () => {
    expect(() => resolvePeriod({ from: '2018-01-01', to: '2026-01-01' }, NOW)).toThrow(/широкий/);
  });

  it('IJ12: диапазон ровно ~5 лет проходит', () => {
    expect(() => resolvePeriod({ from: '2022-01-01', to: '2026-06-01' }, NOW)).not.toThrow();
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

  it('M2: yoy вокруг високосного года НЕ смещает границу на сутки', () => {
    // primary = март 2025 (год ПОСЛЕ високосного 2024). Календарный yoy:
    // 1 мар 2025 → 1 мар 2024 (UTC+5). Старый фикс-мс-сдвиг (366 дней, т.к.
    // 2024 високосный) уводил начало на 29 фев 2024 — на сутки раньше.
    const primaryMar = resolvePeriod({ from: '2025-03-01', to: '2025-03-31' }, NOW);
    const c = resolveComparison(primaryMar, { mode: 'yoy' });
    // 1 мар 2024 00:00 UTC+5 = 29 фев 2024 19:00 UTC (а НЕ 28 фев — багованный сдвиг).
    expect(c!.from.toISOString()).toBe('2024-02-29T19:00:00.000Z');
    // 31 мар 2024 23:59:59.999 UTC+5 = 31 мар 2024 18:59:59.999 UTC.
    expect(c!.to.toISOString()).toBe('2024-03-31T18:59:59.999Z');
  });

  it('M2: yoy с границей 29 фев високосного → клампит к 28 фев (не уезжает в 1 мар)', () => {
    // primary = февраль 2024 (високосный, до 29-го). yoy → 2023 (невисокосный):
    // 29 фев 2023 не существует. Без клампа Date.UTC нормализовал бы в 1 мар 2023
    // (граница уехала бы на сутки вперёд, лишний день в колонке сравнения).
    const primaryFeb = resolvePeriod({ from: '2024-02-01', to: '2024-02-29' }, NOW);
    const c = resolveComparison(primaryFeb, { mode: 'yoy' });
    // 1 фев 2023 00:00 UTC+5 = 31 янв 2023 19:00 UTC.
    expect(c!.from.toISOString()).toBe('2023-01-31T19:00:00.000Z');
    // граница 29 фев 2024 → клампнута к 28 фев 2023 23:59:59.999 UTC+5
    // = 28 фев 2023 18:59:59.999 UTC (а НЕ 1 мар — это и был бы баг).
    expect(c!.to.toISOString()).toBe('2023-02-28T18:59:59.999Z');
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
