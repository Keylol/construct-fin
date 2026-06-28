import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  consumePlan,
  reversePlan,
  weightedUnitCost,
  InsufficientStockError,
  InsufficientReversibleError,
  type OpenLot,
  type ReversibleConsumption,
} from './fifo';
import { D } from './money';
import type { Numeric } from './money';

/**
 * Чистые unit-тесты FIFO-математики (без БД). Каждое числовое ожидание выведено
 * из первых принципов с расчётом в комментарии. Суммы тут ТОЧНЫЕ (без округления):
 * round до 4 знаков делает вызывающий на финальном снимке движения.
 */

const lot = (id: string, qtyRemaining: Numeric, unitCost: Numeric): OpenLot => ({
  id,
  qtyRemaining: D(qtyRemaining),
  unitCost: D(unitCost),
});

const cons = (
  id: string,
  lotId: string,
  remaining: Numeric,
  unitCost: Numeric,
): ReversibleConsumption => ({ id, lotId, remaining: D(remaining), unitCost: D(unitCost) });

/** Σ qty по шагам плана — должна быть == requested без потерь округления. */
const sumQty = (steps: Array<{ qty: Prisma.Decimal }>): string =>
  steps.reduce((acc, s) => acc.plus(s.qty), D(0)).toString();

describe('FIFO: consumePlan', () => {
  it('списание целиком из одной партии', () => {
    // Партия L1: 10 @ 100. Просим 4 → берём 4 из L1.
    // totalCost = 4*100 = 400. Σ take = 4 == requested.
    const plan = consumePlan([lot('L1', '10', '100')], '4');
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.lotId).toBe('L1');
    expect(plan.steps[0]!.qty.toString()).toBe('4');
    expect(plan.steps[0]!.unitCost.toString()).toBe('100');
    expect(plan.totalQty.toString()).toBe('4');
    expect(plan.totalCost.toString()).toBe('400');
    expect(sumQty(plan.steps)).toBe('4');
  });

  it('списание через несколько партий в FIFO-порядке', () => {
    // L1: 10 @ 100, L2: 10 @ 200. Просим 15 → 10 из L1 + 5 из L2.
    // totalCost = 10*100 + 5*200 = 1000 + 1000 = 2000. Σ take = 15.
    const plan = consumePlan([lot('L1', '10', '100'), lot('L2', '10', '200')], '15');
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0]!.lotId).toBe('L1'); // FIFO: первой — старшая партия
    expect(plan.steps[0]!.qty.toString()).toBe('10');
    expect(plan.steps[1]!.lotId).toBe('L2');
    expect(plan.steps[1]!.qty.toString()).toBe('5');
    expect(plan.totalCost.toString()).toBe('2000');
    expect(sumQty(plan.steps)).toBe('15');
  });

  it('шаги строго в FIFO-порядке поданных партий (3 партии)', () => {
    // L1: 2 @ 10, L2: 3 @ 20, L3: 5 @ 30. Просим 9 → 2@10 + 3@20 + 4@30.
    // totalCost = 20 + 60 + 120 = 200. Порядок шагов = порядок партий.
    const plan = consumePlan(
      [lot('L1', '2', '10'), lot('L2', '3', '20'), lot('L3', '5', '30')],
      '9',
    );
    expect(plan.steps.map((s) => s.lotId)).toEqual(['L1', 'L2', 'L3']);
    expect(plan.steps.map((s) => s.qty.toString())).toEqual(['2', '3', '4']);
    expect(plan.totalCost.toString()).toBe('200');
    expect(sumQty(plan.steps)).toBe('9');
  });

  it('дробное количество (14.3) делится между партиями без дрейфа', () => {
    // L1: 10 @ 100, L2: 10 @ 200. Просим 14.3 → 10 из L1 + 4.3 из L2.
    // totalCost = 10*100 + 4.3*200 = 1000 + 860 = 1860. Σ take = 14.3 ровно.
    const plan = consumePlan([lot('L1', '10', '100'), lot('L2', '10', '200')], '14.3');
    expect(plan.steps.map((s) => s.qty.toString())).toEqual(['10', '4.3']);
    expect(plan.totalCost.toString()).toBe('1860');
    expect(plan.totalQty.toString()).toBe('14.3');
    expect(sumQty(plan.steps)).toBe('14.3'); // Σ take == requested, без округления
  });

  it('точная Decimal-стоимость при дробной цене (нет преждевременного round)', () => {
    // L1: 5 @ 33.333333, L2: 5 @ 10. Просим 7 → 5 из L1 + 2 из L2.
    // totalCost = 5*33.333333 + 2*10 = 166.666665 + 20 = 186.666665 (точно, без округления).
    const plan = consumePlan([lot('L1', '5', '33.333333'), lot('L2', '5', '10')], '7');
    expect(plan.totalCost.toString()).toBe('186.666665');
    expect(sumQty(plan.steps)).toBe('7');
  });

  it('пропускает пустые партии (qtyRemaining=0) в очереди', () => {
    // L0 исчерпана (0), L1: 5 @ 100. Просим 3 → берём только из L1.
    const plan = consumePlan([lot('L0', '0', '999'), lot('L1', '5', '100')], '3');
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.lotId).toBe('L1');
    expect(plan.totalCost.toString()).toBe('300');
  });

  it('бросает InsufficientStockError при нехватке суммарного остатка', () => {
    // Доступно 5, просим 6 → ошибка инварианта (вызывающий маппит в 400).
    expect(() => consumePlan([lot('L1', '5', '100')], '6')).toThrow(InsufficientStockError);
    try {
      consumePlan([lot('L1', '5', '100')], '6');
    } catch (e) {
      const err = e as InsufficientStockError;
      expect(err.available.toString()).toBe('5');
      expect(err.requested.toString()).toBe('6');
    }
  });

  it('бросает при requestedQty <= 0', () => {
    expect(() => consumePlan([lot('L1', '5', '100')], '0')).toThrow();
  });
});

describe('FIFO: reversePlan', () => {
  it('LIFO: восстанавливает ПОСЛЕДНЕЕ списанное первым', () => {
    // Потребления (поданы в LIFO-порядке): C2 (последнее, lot L2 @ 200, remaining 5),
    // затем C1 (lot L1 @ 100, remaining 5). Возврат 5 → весь уходит в C2 (lot L2).
    // totalCost = 5*200 = 1000. Затронут только последний потреблённый лот.
    const plan = reversePlan([cons('C2', 'L2', '5', '200'), cons('C1', 'L1', '5', '100')], '5');
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.consumptionId).toBe('C2');
    expect(plan.steps[0]!.lotId).toBe('L2');
    expect(plan.steps[0]!.qty.toString()).toBe('5');
    expect(plan.steps[0]!.unitCost.toString()).toBe('200'); // снимок реверсируемой строки
    expect(plan.totalCost.toString()).toBe('1000');
  });

  it('перетекает на более раннее потребление при остаточной реверсируемости', () => {
    // C2 (lot L2 @ 200) уже частично реверсирован: remaining 3; C1 (lot L1 @ 100) remaining 5.
    // Возврат 5 → 3 из C2 + 2 из C1. totalCost = 3*200 + 2*100 = 600 + 200 = 800.
    const plan = reversePlan([cons('C2', 'L2', '3', '200'), cons('C1', 'L1', '5', '100')], '5');
    expect(plan.steps.map((s) => s.consumptionId)).toEqual(['C2', 'C1']);
    expect(plan.steps.map((s) => s.qty.toString())).toEqual(['3', '2']);
    expect(plan.totalCost.toString()).toBe('800');
  });

  it('берёт цену из снимка потребления, а не из текущего лота (cost-neutral)', () => {
    // Реверс остаточного потребления C1 (снимок 100) — даже если лот позже переоценён,
    // возврат стоит ровно столько, сколько списали. totalCost = 4*100 = 400.
    const plan = reversePlan([cons('C1', 'L1', '4', '100')], '4');
    expect(plan.steps[0]!.unitCost.toString()).toBe('100');
    expect(plan.totalCost.toString()).toBe('400');
  });

  it('бросает InsufficientReversibleError: нельзя вернуть больше списанного', () => {
    // Доступно к реверсу 5, просим 6 → инвариантная ошибка (over-reverse).
    expect(() => reversePlan([cons('C1', 'L1', '5', '100')], '6')).toThrow(
      InsufficientReversibleError,
    );
    try {
      reversePlan([cons('C1', 'L1', '5', '100')], '6');
    } catch (e) {
      const err = e as InsufficientReversibleError;
      expect(err.available.toString()).toBe('5');
      expect(err.requested.toString()).toBe('6');
    }
  });

  it('бросает при requestedQty <= 0', () => {
    expect(() => reversePlan([cons('C1', 'L1', '5', '100')], '0')).toThrow();
  });
});

describe('FIFO: weightedUnitCost', () => {
  it('точное деление без остатка', () => {
    // 1500 / 10 = 150 (ровно).
    expect(weightedUnitCost('1500', '10').toString()).toBe('150');
  });

  it('округляет частное до 4 знаков (half-up)', () => {
    // 2000 / 15 = 133.33333... → round4 = 133.3333.
    expect(weightedUnitCost('2000', '15').toString()).toBe('133.3333');
    // 2 / 3 = 0.666666... → 5-й знак 6 → round4 = 0.6667.
    expect(weightedUnitCost('2', '3').toString()).toBe('0.6667');
  });

  it('guard деления на ноль: totalQty=0 → 0', () => {
    // Полностью распроданная позиция: нет количества → себестоимость 0, без throw.
    expect(weightedUnitCost('1000', '0').toString()).toBe('0');
    expect(weightedUnitCost('0', '0').toString()).toBe('0');
  });
});
