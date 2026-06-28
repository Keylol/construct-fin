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

// R5 (инвариант бизнеса): границы периодов считаем в ФИКСИРОВАННОМ поясе бизнеса
// UTC+5 (Екатеринбург, без перехода на летнее время), а НЕ в локальном поясе
// браузера. Бэк считает в том же поясе — эталон apps/api/src/reports/period.ts
// (OFFSET_MS / tzParts / tzInstant). Иначе у пользователя в Москве (UTC+3) или за
// границей границы суток/месяца/квартала/года уезжали бы на часы и KPI денег у
// стыка периода не совпали бы с бэком. Считаем через явный сдвиг (Date.UTC ± offset)
// — детерминированно в любом TZ, без зависимости от пояса машины.
const OFFSET_MS = 5 * 60 * 60_000;

interface TzParts {
  y: number;
  mo: number; // 0..11
  d: number;
  dow: number; // 0=вс..6=сб (в поясе бизнеса)
}

/** Календарные Y/M/D + день недели момента в поясе бизнеса (UTC+5). */
function tzParts(date: Date): TzParts {
  const s = new Date(date.getTime() + OFFSET_MS);
  return {
    y: s.getUTCFullYear(),
    mo: s.getUTCMonth(),
    d: s.getUTCDate(),
    dow: s.getUTCDay(),
  };
}

/**
 * UTC-инстант, у которого стенные часы в UTC+5 равны (y, mo, d, h:mi:s.ms).
 * Date.UTC нормализует переполнение (d=0 → последний день пред. месяца,
 * d<0 → дальше в прошлое, mo вне 0..11 → соседний год и т.п.).
 */
function tzInstant(
  y: number,
  mo: number,
  d: number,
  h = 0,
  mi = 0,
  s = 0,
  ms = 0,
): Date {
  return new Date(Date.UTC(y, mo, d, h, mi, s, ms) - OFFSET_MS);
}

/** Начало суток (00:00:00.000) даты в поясе бизнеса (UTC+5). */
function startOfDay(d: Date): Date {
  const p = tzParts(d);
  return tzInstant(p.y, p.mo, p.d, 0, 0, 0, 0);
}

/** Конец суток (23:59:59.999) даты в поясе бизнеса (UTC+5). */
function endOfDay(d: Date): Date {
  const p = tzParts(d);
  return tzInstant(p.y, p.mo, p.d, 23, 59, 59, 999);
}

export function rangeFor(key: PeriodKey, now: Date = new Date()): DateRange {
  if (key === 'all') return {};
  if (key === 'today') {
    return { from: toIso(startOfDay(now)), to: toIso(endOfDay(now)) };
  }
  const p = tzParts(now);
  if (key === 'week') {
    // понедельник = 1, воскресенье = 0; смещение до понедельника в поясе бизнеса.
    const offsetToMonday = (p.dow + 6) % 7;
    const monday = tzInstant(p.y, p.mo, p.d - offsetToMonday, 0, 0, 0, 0);
    return { from: toIso(monday), to: toIso(endOfDay(now)) };
  }
  if (key === 'month') {
    return { from: toIso(tzInstant(p.y, p.mo, 1)), to: toIso(endOfDay(now)) };
  }
  if (key === 'quarter') {
    const q = Math.floor(p.mo / 3);
    return { from: toIso(tzInstant(p.y, q * 3, 1)), to: toIso(endOfDay(now)) };
  }
  // year
  return { from: toIso(tzInstant(p.y, 0, 1)), to: toIso(endOfDay(now)) };
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
