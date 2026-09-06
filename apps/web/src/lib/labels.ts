import type { AccountType, ImportSource } from '@/lib/types';

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
