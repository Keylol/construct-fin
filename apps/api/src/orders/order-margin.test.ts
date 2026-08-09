import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { D } from '../common/money';
import { itemMargin, orderMargin, type MarginItemInput } from './order-margin';

/**
 * Unit-тесты чистого расчёта маржи карточки заказа (F1, решение #4).
 * Каскад себестоимости и netQty обязаны совпадать с отчётом маржи
 * (trade-reports/margin.service.ts): те же данные → те же цифры.
 */

function makeItem(over: Partial<MarginItemInput> = {}): MarginItemInput {
  return {
    qty: D('1'),
    returnedQty: D('0'),
    unitPrice: D('100.00'),
    unitCost: null,
    unitCostAtSale: null,
    warehouseItemId: null,
    warehouseItem: null,
    ...over,
  };
}

describe('itemMargin — каскад себестоимости (BR1)', () => {
  it('услуга без себестоимости → source null, COGS 0, 100% маржи (R3)', () => {
    const m = itemMargin(makeItem({ qty: D('2'), unitPrice: D('500.00') }));
    expect(m).toEqual({
      revenue: '1000.00',
      cogs: '0.00',
      margin: '1000.00',
      marginPct: '100.00',
      costSource: null,
      unitCost: '0.00',
    });
  });

  it('ручной unitCost → source manual', () => {
    const m = itemMargin(makeItem({ qty: D('2'), unitPrice: D('150.00'), unitCost: D('100') }));
    expect(m).toEqual({
      revenue: '300.00',
      cogs: '200.00',
      margin: '100.00',
      marginPct: '33.33',
      costSource: 'manual',
      unitCost: '100.00',
    });
  });

  it('unitCostAtSale (факт FIFO) приоритетнее ручного unitCost', () => {
    const m = itemMargin(
      makeItem({ unitPrice: D('200.00'), unitCost: D('50'), unitCostAtSale: D('120') }),
    );
    expect(m.cogs).toBe('120.00');
    expect(m.costSource).toBe('actual');
  });

  it('складская позиция до выдачи → оценка по avgCost склада', () => {
    const m = itemMargin(
      makeItem({
        qty: D('3'),
        unitPrice: D('100.00'),
        warehouseItemId: 'w1',
        warehouseItem: { avgCost: D('60.5000') },
      }),
    );
    expect(m.cogs).toBe('181.50');
    expect(m.margin).toBe('118.50');
    expect(m.costSource).toBe('estimate');
    // Закупка за единицу — та же оценка, что пошла в COGS (money-округление).
    expect(m.unitCost).toBe('60.50');
  });

  it('ручной unitCost приоритетнее оценки по складу', () => {
    const m = itemMargin(
      makeItem({
        unitCost: D('70'),
        warehouseItemId: 'w1',
        warehouseItem: { avgCost: D('60') },
      }),
    );
    expect(m.cogs).toBe('70.00');
    expect(m.costSource).toBe('manual');
  });

  it('складская без include warehouseItem (нет avgCost) → source null, COGS 0', () => {
    const m = itemMargin(makeItem({ warehouseItemId: 'w1', warehouseItem: undefined }));
    expect(m.cogs).toBe('0.00');
    expect(m.costSource).toBeNull();
  });
});

describe('itemMargin — возвраты (netQty) и границы', () => {
  it('частичный возврат сужает выручку и COGS: netQty = qty − returnedQty', () => {
    const m = itemMargin(
      makeItem({
        qty: D('5'),
        returnedQty: D('2'),
        unitPrice: D('100.00'),
        unitCostAtSale: D('40'),
      }),
    );
    expect(m).toEqual({
      revenue: '300.00',
      cogs: '120.00',
      margin: '180.00',
      marginPct: '60.00',
      costSource: 'actual',
      unitCost: '40.00',
    });
  });

  it('полный возврат → нули и 0.00%', () => {
    const m = itemMargin(
      makeItem({ qty: D('2'), returnedQty: D('2'), unitCostAtSale: D('40') }),
    );
    expect(m).toEqual({
      revenue: '0.00',
      cogs: '0.00',
      margin: '0.00',
      marginPct: '0.00',
      costSource: 'actual',
      unitCost: '40.00',
    });
  });

  it('returnedQty > qty (грязные данные) → clamp netQty в 0, не в минус', () => {
    const m = itemMargin(makeItem({ qty: D('1'), returnedQty: D('3') }));
    expect(m.revenue).toBe('0.00');
    expect(m.margin).toBe('0.00');
  });

  it('дробное qty округляется в деньги half-up на строке', () => {
    // 0.333 × 1.00 = 0.333 → 0.33
    const m = itemMargin(makeItem({ qty: D('0.333'), unitPrice: D('1.00') }));
    expect(m.revenue).toBe('0.33');
  });
});

describe('orderMargin — итог заказа (база totalAmount)', () => {
  it('без возвратов выручка = subtotal − скидка = totalAmount (копейка в копейку)', () => {
    const items = [
      makeItem({ qty: D('2'), unitPrice: D('150.00'), unitCost: D('100') }),
      makeItem({ qty: D('1'), unitPrice: D('700.00') }),
    ];
    const s = orderMargin(items, D('50.00'));
    // subtotal = 300 + 700 = 1000; total = 950; COGS = 200
    expect(s).toEqual({
      revenue: '950.00',
      cogs: '200.00',
      margin: '750.00',
      marginPct: '78.95',
      isEstimate: false,
    });
  });

  it('итог считается от НЕокруглённой суммы строк (как Order.subtotal)', () => {
    // Каждая строка: 0.333 → 0.33 в показе; сумма raw = 0.666 → итог 0.67,
    // а не Σ округлённых строк (0.66) — «Доход» бьётся с totalAmount.
    const items = [
      makeItem({ qty: D('0.333'), unitPrice: D('1.00') }),
      makeItem({ qty: D('0.333'), unitPrice: D('1.00') }),
    ];
    const s = orderMargin(items, D('0'));
    expect(s.revenue).toBe('0.67');
  });

  it('возвраты сужают итог; скидка не разносится по строкам', () => {
    const items = [
      makeItem({
        qty: D('5'),
        returnedQty: D('2'),
        unitPrice: D('100.00'),
        unitCostAtSale: D('40'),
      }),
    ];
    const s = orderMargin(items, D('30.00'));
    // netRevenue = 300 − 30 = 270; COGS = 120
    expect(s.revenue).toBe('270.00');
    expect(s.cogs).toBe('120.00');
    expect(s.margin).toBe('150.00');
    expect(s.marginPct).toBe('55.56');
  });

  it('скидка больше остатка выручки после возвратов → clamp 0, убыток виден в %-сигнале', () => {
    const items = [
      makeItem({
        qty: D('2'),
        returnedQty: D('1'),
        unitPrice: D('50.00'),
        unitCostAtSale: D('45'),
      }),
    ];
    const s = orderMargin(items, D('80.00'));
    // netRevenue raw = 50 − 80 = −30 → clamp 0; COGS = 45 → margin = −45
    expect(s.revenue).toBe('0.00');
    expect(s.cogs).toBe('45.00');
    expect(s.margin).toBe('-45.00');
    expect(s.marginPct).toBe('-4500.00');
  });

  it('пустой заказ → нули, 0.00%', () => {
    const s = orderMargin([], D('0'));
    expect(s).toEqual({
      revenue: '0.00',
      cogs: '0.00',
      margin: '0.00',
      marginPct: '0.00',
      isEstimate: false,
    });
  });

  it('isEstimate: оценочная строка помечает итог', () => {
    const items = [
      makeItem({ warehouseItemId: 'w1', warehouseItem: { avgCost: D('10') } }),
      makeItem({ unitCost: D('5') }),
    ];
    expect(orderMargin(items, D('0')).isEstimate).toBe(true);
  });

  it('isEstimate: полностью возвращённая оценочная строка итог НЕ пятнает', () => {
    const items = [
      makeItem({
        qty: D('1'),
        returnedQty: D('1'),
        warehouseItemId: 'w1',
        warehouseItem: { avgCost: D('10') },
      }),
      makeItem({ unitCost: D('5') }),
    ];
    expect(orderMargin(items, D('0')).isEstimate).toBe(false);
  });

  it('isEstimate: пустой склад (avgCost 0) — всё равно оценка', () => {
    const items = [
      makeItem({ warehouseItemId: 'w1', warehouseItem: { avgCost: D('0') } }),
    ];
    const s = orderMargin(items, D('0'));
    expect(s.isEstimate).toBe(true);
    expect(s.cogs).toBe('0.00');
  });

  it('строки Decimal из Prisma (не обёртки D) принимаются как есть', () => {
    const s = orderMargin(
      [makeItem({ qty: new Prisma.Decimal(2), unitPrice: new Prisma.Decimal('99.99') })],
      new Prisma.Decimal(0),
    );
    expect(s.revenue).toBe('199.98');
  });
});
