import type { AccountType, ImportSource, TransactionKind } from '@/lib/types';

/**
 * Словари подписей, которые нужны больше чем одному экрану. Один владелец на
 * словарь: раньше тип счёта был описан в «Счетах» и в «Импорте» под разными
 * именами, месяцы — в налоге и бюджете, источник импорта — в двух соседних
 * файлах.
 */
export const ACCOUNT_TYPE_LABEL: Record<AccountType, string> = {
  CASH: 'Наличные',
  BANK: 'Банк',
  OTHER: 'Другое',
};

export const IMPORT_SOURCE_LABEL: Record<ImportSource, string> = {
  ALFA_XLSX: 'Альфа-Банк (xlsx)',
  WB_PDF: 'Wildberries (pdf)',
  TINKOFF_PDF: 'Т-Банк (pdf)',
  GENERIC_CSV: 'CSV',
  GENERIC_XLSX: 'Excel',
};

/** Именительный падеж: «Январь», для заголовков периодов. */
export const MONTH_NAMES = [
  'Январь',
  'Февраль',
  'Март',
  'Апрель',
  'Май',
  'Июнь',
  'Июль',
  'Август',
  'Сентябрь',
  'Октябрь',
  'Ноябрь',
  'Декабрь',
] as const;

/**
 * Вид операции без статьи — подпись фильтра «Операций», куда ведёт группа
 * расходов «Итогов месяца» («Зарплата» без статьи и т.п.).
 */
export const KIND_NO_CATEGORY_LABEL: Record<TransactionKind, string> = {
  SALARY: 'Зарплата без статьи',
  VARIABLE_COST: 'Комиссии без статьи',
  FIXED_COST: 'Постоянные без статьи',
  TAX: 'Налог без статьи',
  NON_OP: 'Внереализационные без статьи',
  OTHER: 'Прочее без статьи',
  ORDER_PAYMENT: 'Оплаты заказов',
  ORDER_REFUND: 'Возвраты клиентам',
  COGS: 'Себестоимость заказов',
  WRITE_OFF: 'Списания со склада',
  PURCHASE: 'Закупки',
  SUPPLIER_REFUND: 'Возвраты поставщиков',
  CAPITAL_IN: 'Вложения владельца',
  CAPITAL_OUT: 'Изъятия владельца',
};
