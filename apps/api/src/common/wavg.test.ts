import { describe, it, expect } from 'vitest';
import {
  applyPurchase,
  applySale,
  applyReturn,
  applySupplierReturn,
  InsufficientStockError,
} from './wavg';

describe('WAVG: applyPurchase', () => {
  it('первая закупка задаёт avgCost = цене', () => {
    const r = applyPurchase(0, 0, 10, 100);
    expect(r.qty.toString()).toBe('10');
    expect(r.avgCost.toString()).toBe('100');
  });

  it('вторая закупка по другой цене даёт среднее', () => {
    // 10 шт по 100, добавили 10 по 200 → 20 шт по 150
    const r = applyPurchase(10, 100, 10, 200);
    expect(r.qty.toString()).toBe('20');
    expect(r.avgCost.toString()).toBe('150');
  });

  it('дробное среднее округляется до 4 знаков', () => {
    // 3 по 100 + 1 по 150 → 4 шт, value 450, avg 112.5
    const r = applyPurchase(3, 100, 1, 150);
    expect(r.qty.toString()).toBe('4');
    expect(r.avgCost.toString()).toBe('112.5');
  });
});

describe('WAVG: applySale', () => {
  it('продажа не меняет avgCost, возвращает unitCost = avg', () => {
    const { state, unitCost } = applySale(20, 150, 5);
    expect(state.qty.toString()).toBe('15');
    expect(state.avgCost.toString()).toBe('150');
    expect(unitCost.toString()).toBe('150');
  });

  it('бросает при нехватке остатка', () => {
    expect(() => applySale(3, 150, 5)).toThrow(InsufficientStockError);
  });

  it('разрешает отрицательный остаток при allowNegative', () => {
    const { state } = applySale(3, 150, 5, true);
    expect(state.qty.toString()).toBe('-2');
  });
});

describe('WAVG: applyReturn (от клиента)', () => {
  it('возврат увеличивает qty, avgCost не меняется', () => {
    const r = applyReturn(15, 150, 2);
    expect(r.qty.toString()).toBe('17');
    expect(r.avgCost.toString()).toBe('150');
  });
});

describe('WAVG: applySupplierReturn', () => {
  it('возврат поставщику пересчитывает среднее на остаток', () => {
    // 20 шт по 150 (value 3000), вернули 3 по 200 (refund 600)
    // newValue = 3000 - 600 = 2400, newQty = 17, avg = 141.1765
    const r = applySupplierReturn(20, 150, 3, 600);
    expect(r.qty.toString()).toBe('17');
    expect(r.avgCost.toFixed(2)).toBe('141.18');
  });

  it('полный возврат обнуляет склад', () => {
    const r = applySupplierReturn(5, 100, 5, 500);
    expect(r.qty.toString()).toBe('0');
    expect(r.avgCost.toString()).toBe('0');
  });

  it('B6: refund больше стоимости остатка → avgCost clamp до 0 (не уходит в минус)', () => {
    // 10 шт по 100 (value 1000), вернули 2, но refund 5000 (> 1000).
    // newValue = 1000 − 5000 = −4000 → clamp 0 → avgCost 0 на остатке 8.
    const r = applySupplierReturn(10, 100, 2, 5000);
    expect(r.qty.toString()).toBe('8');
    expect(r.avgCost.toString()).toBe('0');
    expect(r.avgCost.isNegative()).toBe(false);
  });
});

describe('WAVG: сквозной сценарий', () => {
  it('закупка → закупка → продажа → возврат сохраняют целостность', () => {
    let s = applyPurchase(0, 0, 10, 100); // 10 @ 100
    s = applyPurchase(s.qty, s.avgCost, 10, 200); // 20 @ 150
    expect(s.avgCost.toString()).toBe('150');
    const sale = applySale(s.qty, s.avgCost, 5); // -5 → 15 @ 150, cost 150
    expect(sale.state.qty.toString()).toBe('15');
    expect(sale.unitCost.toString()).toBe('150');
    const ret = applyReturn(sale.state.qty, sale.state.avgCost, 2); // +2 → 17 @ 150
    expect(ret.qty.toString()).toBe('17');
    expect(ret.avgCost.toString()).toBe('150');
  });
});
