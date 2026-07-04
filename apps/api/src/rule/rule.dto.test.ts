import { describe, it, expect } from 'vitest';
import { CreateRuleSchema, RuleConditionSchema } from './rule.dto';

const cuid = 'cme00000000000000000000zz';

describe('CreateRuleSchema — валидация словаря', () => {
  it('принимает валидное правило', () => {
    const r = CreateRuleSchema.safeParse({
      name: 'Аренда → Постоянные',
      conditions: [{ type: 'DESCRIPTION_CONTAINS', value: 'аренд' }],
      actions: [{ type: 'SET_CATEGORY', categoryId: cuid }],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.priority).toBe(0); // дефолт
      expect(r.data.appliesTo).toBe('BOTH'); // дефолт
    }
  });

  it('отвергает правило без условий (защита от «правила на всё»)', () => {
    const r = CreateRuleSchema.safeParse({
      name: 'x',
      conditions: [],
      actions: [{ type: 'SET_CATEGORY', categoryId: cuid }],
    });
    expect(r.success).toBe(false);
  });

  it('отвергает правило без действий', () => {
    const r = CreateRuleSchema.safeParse({
      name: 'x',
      conditions: [{ type: 'DESCRIPTION_CONTAINS', value: 'а' }],
      actions: [],
    });
    expect(r.success).toBe(false);
  });

  it('AMOUNT_RANGE без границ отвергается', () => {
    expect(RuleConditionSchema.safeParse({ type: 'AMOUNT_RANGE' }).success).toBe(false);
    expect(RuleConditionSchema.safeParse({ type: 'AMOUNT_RANGE', min: '100' }).success).toBe(true);
  });

  it('неизвестный type условия отвергается', () => {
    expect(RuleConditionSchema.safeParse({ type: 'REGEX_MATCH', value: '.*' }).success).toBe(false);
  });

  it('невалидная сумма в диапазоне отвергается', () => {
    expect(RuleConditionSchema.safeParse({ type: 'AMOUNT_RANGE', min: 'abc' }).success).toBe(false);
    expect(RuleConditionSchema.safeParse({ type: 'AMOUNT_RANGE', min: '10.999' }).success).toBe(false);
  });
});
