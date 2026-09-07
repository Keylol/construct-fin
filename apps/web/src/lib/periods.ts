/**
 * Хелперы для рабочих периодов. Первый день недели — понедельник,
 * месяц начинается с 1-го (российский стандарт, согласовано в блице).
 */

import type { PeriodPreset } from '@/lib/types';

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

/**
 * Пресеты отчётов → диапазон дат. Зеркало `resolvePreset` из
 * `apps/api/src/reports/period.ts`: отчёты отдают на бэк сам пресет, а список
 * операций фильтруется по from/to, и границы обязаны совпадать до секунды —
 * иначе клик из отчёта в операции показывает другую сумму.
 */
export function rangeForPreset(preset: PeriodPreset, now: Date = new Date()): DateRange {
  const p = tzParts(now);
  const startOfMonthIso = (y: number, mo: number) => toIso(tzInstant(y, mo, 1));
  const endOfMonthIso = (y: number, mo: number) =>
    toIso(tzInstant(y, mo + 1, 0, 23, 59, 59, 999));
  const nowIso = toIso(endOfDay(now));

  switch (preset) {
    case 'this-month':
      return { from: startOfMonthIso(p.y, p.mo), to: nowIso };
    case 'prev-month':
      return { from: startOfMonthIso(p.y, p.mo - 1), to: endOfMonthIso(p.y, p.mo - 1) };
    case 'this-quarter':
      return { from: startOfMonthIso(p.y, Math.floor(p.mo / 3) * 3), to: nowIso };
    case 'prev-quarter': {
      const q = Math.floor(p.mo / 3);
      return {
        from: startOfMonthIso(p.y, q * 3 - 3),
        to: endOfMonthIso(p.y, q * 3 - 1),
      };
    }
    case 'this-year':
    case 'ytd':
      return { from: startOfMonthIso(p.y, 0), to: nowIso };
    case 'prev-year':
      return { from: startOfMonthIso(p.y - 1, 0), to: endOfMonthIso(p.y - 1, 11) };
    case 'last-30d':
      return { from: toIso(tzInstant(p.y, p.mo, p.d - 29, 0, 0, 0, 0)), to: nowIso };
    case 'last-90d':
      return { from: toIso(tzInstant(p.y, p.mo, p.d - 89, 0, 0, 0, 0)), to: nowIso };
    case 'last-12m':
    default:
      return { from: startOfMonthIso(p.y, p.mo - 11), to: nowIso };
  }
}

/**
 * Период списка операций: пресеты отчётов плюс три коротких, которых в отчётах
 * нет («сегодня», «неделя», «всё время»). Один список на экран — чтобы период
 * выбирался везде одинаково, а не тремя разными наборами слов.
 */
export type AnyPeriod = PeriodKey | PeriodPreset;

export const ANY_PERIOD_LABELS: Record<AnyPeriod, string> = {
  today: 'Сегодня',
  week: 'Неделя',
  'this-month': 'Этот месяц',
  'prev-month': 'Прошлый месяц',
  'this-quarter': 'Этот квартал',
  'prev-quarter': 'Прошлый квартал',
  'this-year': 'Этот год',
  ytd: 'С начала года',
  'prev-year': 'Прошлый год',
  'last-30d': '30 дней',
  'last-90d': '90 дней',
  'last-12m': '12 месяцев',
  all: 'Всё время',
  // Ключи старого набора остаются валидными: по ним приходят сохранённый выбор
  // из localStorage и ссылки, сделанные до объединения.
  month: 'Этот месяц',
  quarter: 'Этот квартал',
  year: 'Этот год',
};

/** Порядок в выпадающем списке: от короткого к длинному. */
export const ANY_PERIOD_ORDER: AnyPeriod[] = [
  'today',
  'week',
  'this-month',
  'prev-month',
  'this-quarter',
  'prev-quarter',
  'this-year',
  'ytd',
  'prev-year',
  'last-30d',
  'last-90d',
  'last-12m',
  'all',
];

const OLD_KEYS: PeriodKey[] = ['today', 'week', 'month', 'quarter', 'year', 'all'];

export function rangeForAny(p: AnyPeriod, now: Date = new Date()): DateRange {
  return (OLD_KEYS as string[]).includes(p)
    ? rangeFor(p as PeriodKey, now)
    : rangeForPreset(p as PeriodPreset, now);
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
/** Сегодня для `<input type="date">` — в бизнес-поясе, а не по UTC. */
export function todayInput(now: Date = new Date()): string {
  return toLocalDateInput(now);
}

export function toLocalDateInput(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Из YYYY-MM-DD в ISO. */
export function fromLocalDateInput(s: string): string {
  // Полдень берём в ФИКСИРОВАННОМ поясе бизнеса (UTC+5), а НЕ в локальном поясе
  // браузера. Иначе западнее UTC+5 (Москва UTC+3, Европа и т.д.) `new Date(`${s}T12:00:00`)`
  // строит полдень локального дня, и при .toISOString() дата могла уехать на сутки
  // относительно бэка. Считаем через тот же tzInstant, что и rangeFor (R5) —
  // детерминированно в любом TZ раннера/браузера.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return new Date(`${s}T12:00:00+05:00`).toISOString();
  return toIso(tzInstant(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
}
