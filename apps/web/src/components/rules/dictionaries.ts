import type {
  RuleAction,
  RuleActionType,
  RuleAppliesTo,
  RuleCondition,
  RuleConditionType,
} from '@/lib/types';

/** Человекочитаемые метки словаря правил — зеркало rule.dto.ts бэкенда. */
export const CONDITION_LABELS: Record<RuleConditionType, string> = {
  DESCRIPTION_CONTAINS: 'Описание содержит',
  COUNTERPARTY_EQUALS: 'Контрагент — это',
  COUNTERPARTY_INN_IN: 'ИНН контрагента — один из',
  ACCOUNT_EQUALS: 'Счёт — это',
  TYPE_EQUALS: 'Тип операции',
  AMOUNT_RANGE: 'Сумма в диапазоне',
  SOURCE_EQUALS: 'Источник',
};

export const ACTION_LABELS: Record<RuleActionType, string> = {
  SET_CATEGORY: 'Поставить категорию',
  SET_COUNTERPARTY: 'Поставить контрагента',
  SET_ACCOUNT: 'Поставить счёт',
};

export const APPLIES_TO_LABELS: Record<RuleAppliesTo, string> = {
  IMPORT: 'Импорт',
  MANUAL: 'Ручной ввод',
  BOTH: 'Везде',
};

export function defaultCondition(type: RuleConditionType): RuleCondition {
  switch (type) {
    case 'DESCRIPTION_CONTAINS':
      return { type, value: '' };
    case 'COUNTERPARTY_EQUALS':
      return { type, counterpartyId: '' };
    case 'COUNTERPARTY_INN_IN':
      return { type, values: [] };
    case 'ACCOUNT_EQUALS':
      return { type, accountId: '' };
    case 'TYPE_EQUALS':
      return { type, value: 'EXPENSE' };
    case 'AMOUNT_RANGE':
      return { type, min: '', max: '' };
    case 'SOURCE_EQUALS':
      return { type, value: 'IMPORT' };
  }
}

export function defaultAction(type: RuleActionType): RuleAction {
  switch (type) {
    case 'SET_CATEGORY':
      return { type, categoryId: '' };
    case 'SET_COUNTERPARTY':
      return { type, counterpartyId: '' };
    case 'SET_ACCOUNT':
      return { type, accountId: '' };
  }
}

/** Условие заполнено настолько, что его уже можно проверить предпросмотром. */
export function isConditionFilled(c: RuleCondition): boolean {
  switch (c.type) {
    case 'DESCRIPTION_CONTAINS':
      return c.value.trim().length > 0;
    case 'COUNTERPARTY_EQUALS':
      return !!c.counterpartyId;
    case 'COUNTERPARTY_INN_IN':
      return c.values.some((v) => v.length === 10 || v.length === 12);
    case 'ACCOUNT_EQUALS':
      return !!c.accountId;
    case 'AMOUNT_RANGE':
      return (c.min != null && c.min !== '') || (c.max != null && c.max !== '');
    case 'TYPE_EQUALS':
    case 'SOURCE_EQUALS':
      return true;
  }
}
