import { describe, it, expect } from 'vitest';
import { applyRules, type RuleDef, type RuleContext } from './engine';

function rule(over: Partial<RuleDef> & Pick<RuleDef, 'conditions' | 'actions'>): RuleDef {
  return { id: over.id ?? 'r1', name: over.name ?? 'rule', priority: over.priority ?? 0, ...over };
}
const base: RuleContext = { source: 'MANUAL' };

describe('движок правил: сопоставление условий', () => {
  it('DESCRIPTION_CONTAINS — по описанию и имени контрагента, регистронезависимо', () => {
    // Основа слова (стем) — подстрочное совпадение ловит все формы (аренда/аренды).
    const r = rule({
      conditions: [{ type: 'DESCRIPTION_CONTAINS', value: 'Аренд' }],
      actions: [{ type: 'SET_CATEGORY', categoryId: 'cat-rent' }],
    });
    expect(applyRules([r], { ...base, description: 'Оплата АРЕНДЫ офиса' }).categoryId).toBe('cat-rent');
    expect(applyRules([r], { ...base, counterpartyName: 'ООО Аренда+' }).categoryId).toBe('cat-rent');
    expect(applyRules([r], { ...base, description: 'зарплата' }).categoryId).toBeUndefined();
  });

  it('условия комбинируются по И — срабатывает только когда ВСЕ истинны', () => {
    const r = rule({
      conditions: [
        { type: 'DESCRIPTION_CONTAINS', value: 'такси' },
        { type: 'TYPE_EQUALS', value: 'EXPENSE' },
      ],
      actions: [{ type: 'SET_CATEGORY', categoryId: 'cat-transport' }],
    });
    expect(applyRules([r], { ...base, description: 'такси', type: 'EXPENSE' }).categoryId).toBe('cat-transport');
    // тип не тот → не срабатывает
    expect(applyRules([r], { ...base, description: 'такси', type: 'INCOME' }).categoryId).toBeUndefined();
  });

  it('AMOUNT_RANGE — по модулю, min/max включительно, null-границы открыты', () => {
    const r = rule({
      conditions: [{ type: 'AMOUNT_RANGE', min: '1000', max: '5000' }],
      actions: [{ type: 'SET_CATEGORY', categoryId: 'cat-mid' }],
    });
    expect(applyRules([r], { ...base, amount: '1000' }).categoryId).toBe('cat-mid'); // граница
    expect(applyRules([r], { ...base, amount: '-3000' }).categoryId).toBe('cat-mid'); // по модулю
    expect(applyRules([r], { ...base, amount: '9999' }).categoryId).toBeUndefined();
    expect(applyRules([r], { ...base }).categoryId).toBeUndefined(); // нет суммы → не матчит
  });

  it('COUNTERPARTY_EQUALS / ACCOUNT_EQUALS / SOURCE_EQUALS', () => {
    const r = rule({
      conditions: [
        { type: 'COUNTERPARTY_EQUALS', counterpartyId: 'cp1' },
        { type: 'ACCOUNT_EQUALS', accountId: 'acc1' },
        { type: 'SOURCE_EQUALS', value: 'IMPORT' },
      ],
      actions: [{ type: 'SET_CATEGORY', categoryId: 'cat-x' }],
    });
    expect(
      applyRules([r], { source: 'IMPORT', counterpartyId: 'cp1', accountId: 'acc1' }).categoryId,
    ).toBe('cat-x');
    // источник не тот
    expect(
      applyRules([r], { source: 'MANUAL', counterpartyId: 'cp1', accountId: 'acc1' }).categoryId,
    ).toBeUndefined();
  });

  it('пустой набор условий НЕ срабатывает (защита от «правила на всё»)', () => {
    const r = rule({ conditions: [], actions: [{ type: 'SET_CATEGORY', categoryId: 'cat-any' }] });
    expect(applyRules([r], { ...base, description: 'что угодно' }).categoryId).toBeUndefined();
  });
});

describe('движок правил: приоритет и слияние действий', () => {
  it('при конфликте на одно поле выигрывает более приоритетное правило', () => {
    const low = rule({
      id: 'low',
      priority: 1,
      conditions: [{ type: 'DESCRIPTION_CONTAINS', value: 'оплата' }],
      actions: [{ type: 'SET_CATEGORY', categoryId: 'cat-low' }],
    });
    const high = rule({
      id: 'high',
      priority: 10,
      conditions: [{ type: 'DESCRIPTION_CONTAINS', value: 'оплата' }],
      actions: [{ type: 'SET_CATEGORY', categoryId: 'cat-high' }],
    });
    const s = applyRules([low, high], { ...base, description: 'оплата' });
    expect(s.categoryId).toBe('cat-high');
    expect(s.matchedRuleIds).toEqual(['high']); // low не применился (поле занято)
  });

  it('непересекающиеся действия разных правил сливаются', () => {
    const r1 = rule({
      id: 'r1',
      conditions: [{ type: 'DESCRIPTION_CONTAINS', value: 'озон' }],
      actions: [{ type: 'SET_CATEGORY', categoryId: 'cat-market' }],
    });
    const r2 = rule({
      id: 'r2',
      conditions: [{ type: 'DESCRIPTION_CONTAINS', value: 'озон' }],
      actions: [{ type: 'SET_COUNTERPARTY', counterpartyId: 'cp-ozon' }],
    });
    const s = applyRules([r1, r2], { ...base, description: 'озон покупка' });
    expect(s.categoryId).toBe('cat-market');
    expect(s.counterpartyId).toBe('cp-ozon');
    expect(s.matchedRuleIds.sort()).toEqual(['r1', 'r2']);
  });

  it('нет совпадений → пустая подсказка', () => {
    const r = rule({
      conditions: [{ type: 'DESCRIPTION_CONTAINS', value: 'редкость' }],
      actions: [{ type: 'SET_CATEGORY', categoryId: 'cat-x' }],
    });
    const s = applyRules([r], { ...base, description: 'обычная операция' });
    expect(s.categoryId).toBeUndefined();
    expect(s.matchedRuleIds).toEqual([]);
  });
});
