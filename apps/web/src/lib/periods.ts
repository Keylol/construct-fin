/**
 * Хелперы для рабочих периодов. Первый день недели — понедельник,
 * месяц начинается с 1-го (российский стандарт, согласовано в блице).
 */

export type PeriodKey = 'today' | 'week' | 'month' | 'quarter' | 'year' | 'all';

export interface DateRange {
  from?: string; // ISO date
  to?: string;
}

function toIso(d: Date): string {
  return d.toISOString();
}

function startOfDay(d: Date): Date {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return r;
}

function endOfDay(d: Date): Date {
  const r = new Date(d);
  r.setHours(23, 59, 59, 999);
  return r;
}

export function rangeFor(key: PeriodKey, now: Date = new Date()): DateRange {
  if (key === 'all') return {};
  if (key === 'today') {
    return { from: toIso(startOfDay(now)), to: toIso(endOfDay(now)) };
  }
  if (key === 'week') {
    // понедельник = 1, воскресенье = 0
    const day = now.getDay();
    const offsetToMonday = (day + 6) % 7;
    const monday = new Date(now);
    monday.setDate(now.getDate() - offsetToMonday);
    return { from: toIso(startOfDay(monday)), to: toIso(endOfDay(now)) };
  }
  if (key === 'month') {
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    return { from: toIso(startOfDay(first)), to: toIso(endOfDay(now)) };
  }
  if (key === 'quarter') {
    const q = Math.floor(now.getMonth() / 3);
    const first = new Date(now.getFullYear(), q * 3, 1);
    return { from: toIso(startOfDay(first)), to: toIso(endOfDay(now)) };
  }
  // year
  const first = new Date(now.getFullYear(), 0, 1);
  return { from: toIso(startOfDay(first)), to: toIso(endOfDay(now)) };
}

export const PERIOD_LABELS: Record<PeriodKey, string> = {
  today: 'Сегодня',
  week: 'Неделя',
  month: 'Месяц',
  quarter: 'Квартал',
  year: 'Год',
  all: 'Всё время',
};

/** Локальная дата YYYY-MM-DD для <input type="date">. */
export function toLocalDateInput(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Из YYYY-MM-DD в ISO. */
export function fromLocalDateInput(s: string): string {
  return new Date(`${s}T12:00:00`).toISOString();
}
