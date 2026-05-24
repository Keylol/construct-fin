/**
 * Чистые функции вычисления occurrence-дат для RecurringRule.
 * Без зависимости от Prisma — удобно тестировать.
 */

import type { Frequency } from './recurring.dto';

export const MS_PER_DAY = 24 * 60 * 60 * 1000;
export const CATCH_UP_LIMIT_DAYS = 30;

export interface ScheduleInput {
  frequency: Frequency;
  interval: number;
  startDate: Date;
  endDate?: Date | null;
  dayOfMonth?: number | null;
  dayOfWeek?: number | null;
}

/** Возвращает следующую дату после `from`, выровненную по правилу. */
export function nextOccurrence(rule: ScheduleInput, from: Date): Date {
  const d = new Date(from);
  switch (rule.frequency) {
    case 'DAILY':
      d.setUTCDate(d.getUTCDate() + rule.interval);
      return d;
    case 'WEEKLY':
      d.setUTCDate(d.getUTCDate() + 7 * rule.interval);
      if (rule.dayOfWeek !== undefined && rule.dayOfWeek !== null) {
        // 0=пн ... 6=вс. JS getUTCDay: 0=вс ... 6=сб, поэтому конвертим.
        const target = rule.dayOfWeek;
        const jsTarget = (target + 1) % 7; // пн=1 ... вс=0
        const currJs = d.getUTCDay();
        const diff = (jsTarget - currJs + 7) % 7;
        d.setUTCDate(d.getUTCDate() + diff);
      }
      return d;
    case 'MONTHLY': {
      const targetDay = rule.dayOfMonth ?? d.getUTCDate();
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() + rule.interval);
      const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      d.setUTCDate(Math.min(targetDay, lastDay));
      return d;
    }
    case 'YEARLY':
      d.setUTCFullYear(d.getUTCFullYear() + rule.interval);
      return d;
  }
}

/** Возвращает первую дату ≥ floor, идущую по правилу от startDate. */
export function firstOccurrenceAfter(rule: ScheduleInput, floor: Date): Date {
  let d = new Date(rule.startDate);
  // Для месячного с dayOfMonth — выравниваем startDate
  if (rule.frequency === 'MONTHLY' && rule.dayOfMonth) {
    const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(rule.dayOfMonth, lastDay));
  }
  // Если startDate в будущем — она и есть первая
  if (d >= floor) return d;
  // Иначе шагаем вперёд
  let safety = 0;
  while (d < floor && safety < 100_000) {
    d = nextOccurrence(rule, d);
    safety++;
  }
  if (safety >= 100_000) throw new Error('firstOccurrenceAfter: safety limit');
  return d;
}

/**
 * Перечисляет все occurrence-даты в окне [floor, ceiling].
 * `floor` = max(startDate, lastRunAt+ε, now - CATCH_UP_LIMIT_DAYS).
 */
export function enumerateOccurrences(
  rule: ScheduleInput,
  options: { lastRunAt?: Date | null; now: Date },
): Date[] {
  const catchUpFloor = new Date(options.now.getTime() - CATCH_UP_LIMIT_DAYS * MS_PER_DAY);
  // После lastRunAt — берём следующее, ИЛИ если lastRunAt нет — startDate
  const baseFloor = options.lastRunAt
    ? nextOccurrence(rule, options.lastRunAt)
    : rule.startDate;
  const floor = baseFloor > catchUpFloor ? baseFloor : catchUpFloor;

  const result: Date[] = [];
  let curr = firstOccurrenceAfter(rule, floor);
  let safety = 0;
  while (curr <= options.now && (!rule.endDate || curr <= rule.endDate) && safety < 1000) {
    result.push(new Date(curr));
    curr = nextOccurrence(rule, curr);
    safety++;
  }
  return result;
}

/** Следующий запуск после `now`. */
export function computeNextRunAt(rule: ScheduleInput, now: Date): Date | null {
  if (rule.endDate && now > rule.endDate) return null;
  const floor = now > rule.startDate ? new Date(now.getTime() + 1) : rule.startDate;
  const next = firstOccurrenceAfter(rule, floor);
  if (rule.endDate && next > rule.endDate) return null;
  return next;
}
