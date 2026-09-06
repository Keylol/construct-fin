import type { PlannedPayment, PlannedTxKind, RecurringPayment } from '@/lib/types';

/**
 * Общий словарь и хелперы контура плановых платежей. Используются экранами
 * «Платежи» (/planning) и «Зарплата» (/salary) — один источник, без дублей.
 */

export const TX_KIND_LABEL: Record<PlannedTxKind, string> = {
  FIXED_COST: 'Постоянные',
  VARIABLE_COST: 'Переменные',
  SALARY: 'Зарплата',
  TAX: 'Налог',
  NON_OP: 'Внереализационные',
  OTHER: 'Прочее',
};
export const TX_KINDS: PlannedTxKind[] = [
  'FIXED_COST',
  'VARIABLE_COST',
  'SALARY',
  'TAX',
  'NON_OP',
  'OTHER',
];
export const WEEKDAYS = [
  'Воскресенье',
  'Понедельник',
  'Вторник',
  'Среда',
  'Четверг',
  'Пятница',
  'Суббота',
];

/** «через N дней» / «сегодня» / «просрочено N дн» словами. */
export function dueLabel(p: PlannedPayment): string {
  if (p.dueInDays === 0) return 'сегодня';
  if (p.dueInDays < 0) return `просрочено ${Math.abs(p.dueInDays)} дн.`;
  return `через ${p.dueInDays} дн.`;
}

export function dueChipClass(p: PlannedPayment): string {
  if (p.overdue) return 'bg-destructive/15 text-destructive';
  if (p.soon) return 'bg-warning/15 text-warning';
  return 'bg-secondary text-muted-foreground';
}

/** Человекочитаемый график регулярного платежа. */
export function scheduleLabel(r: RecurringPayment): string {
  if (r.cadence === 'MONTHLY') return `Ежемесячно, ${r.dayOfMonth}-го числа`;
  return `Еженедельно, ${WEEKDAYS[r.weekday ?? 0]}`;
}

// Дата ↔ поле формы: единственный конвертер живёт в lib/periods (UTC+5, покрыт
// тестом). Здесь были свои копии в UTC — они расходились с ним на границе суток.
export { todayInput as todayISODate, fromLocalDateInput as dateToNoonIso } from '@/lib/periods';
