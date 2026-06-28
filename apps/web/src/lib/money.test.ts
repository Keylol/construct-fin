import { describe, it, expect } from 'vitest';
import { parseAmountInput, formatRub } from '@construct/shared';

/**
 * E4 (Трек E): юниты на денежные хелперы фронта — главный фронт-риск (деньги как
 * строка-Decimal легко сломать). parseAmountInput должен отдавать строку с 2
 * знаками для API; formatRub — рубли RU или «—» на мусоре.
 */

describe('parseAmountInput', () => {
  it('нормализует пробелы и запятую → строка с 2 знаками', () => {
    expect(parseAmountInput('1 234,50')).toBe('1234.50');
    expect(parseAmountInput('1234.5')).toBe('1234.50');
    expect(parseAmountInput('0')).toBe('0.00');
  });

  it('отвергает мусор и >2 знаков после запятой', () => {
    expect(parseAmountInput('abc')).toBeNull();
    expect(parseAmountInput('12.345')).toBeNull();
    expect(parseAmountInput('')).toBeNull();
  });

  it('допускает отрицательные (сторно-ввод)', () => {
    expect(parseAmountInput('-50,5')).toBe('-50.50');
  });

  it('не теряет копейку на больших суммах (Decimal, не IEEE754 float)', () => {
    // Number('99999999999999.99').toFixed(2) === '99999999999999.98' (потеря копейки).
    // Decimal сохраняет точную копейку.
    expect(parseAmountInput('99 999 999 999 999,99')).toBe('99999999999999.99');
    expect(Number('99999999999999.99').toFixed(2)).toBe('99999999999999.98'); // регрессия-якорь
  });
});

describe('formatRub', () => {
  it('форматирует число/строку в рубли (RU)', () => {
    const out = formatRub('1234.5');
    expect(out).toContain('234');
    expect(out).toContain('50');
    expect(out).toContain('₽');
  });

  it('на нечисловом входе → «—»', () => {
    expect(formatRub('не-число')).toBe('—');
    expect(formatRub(Number.NaN)).toBe('—');
  });
});
