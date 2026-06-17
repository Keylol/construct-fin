import { BadRequestException } from '@nestjs/common';

export type PeriodPreset =
  | 'this-month'
  | 'prev-month'
  | 'this-quarter'
  | 'prev-quarter'
  | 'this-year'
  | 'prev-year'
  | 'ytd'
  | 'last-30d'
  | 'last-90d'
  | 'last-12m';

export type CompareMode = 'none' | 'prev' | 'yoy' | 'custom';

export interface Period {
  from: Date;
  to: Date;
}

export interface ResolvedPeriods {
  primary: Period;
  comparison: Period | null;
}

// R5: границы день/месяц/квартал/год считаем в фиксированном поясе бизнеса
// UTC+5 (Екатеринбург, без перехода на летнее время), а НЕ в поясе сервера.
// Иначе на сервере с другим TZ операции на стыке суток уезжали бы в соседний
// период. Реализовано через явный сдвиг (Date.UTC ± offset), без зависимости от
// process.env.TZ — детерминированно в любом окружении и в тестах.
const TZ_OFFSET_MIN = 5 * 60;
const OFFSET_MS = TZ_OFFSET_MIN * 60_000;

interface TzParts {
  y: number;
  mo: number; // 0..11
  d: number;
}

/** Календарные Y/M/D момента в поясе бизнеса (UTC+5). */
function tzParts(date: Date): TzParts {
  const shifted = new Date(date.getTime() + OFFSET_MS);
  return { y: shifted.getUTCFullYear(), mo: shifted.getUTCMonth(), d: shifted.getUTCDate() };
}

/**
 * UTC-инстант, у которого стенные часы в UTC+5 равны (y, mo, d, h:mi:s.ms).
 * Date.UTC нормализует переполнение (mo=-1 → декабрь пред. года, d=0 → последний
 * день пред. месяца, d=32 → следующий месяц и т.п.).
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

function startOfDay(date: Date): Date {
  const p = tzParts(date);
  return tzInstant(p.y, p.mo, p.d, 0, 0, 0, 0);
}

function endOfDay(date: Date): Date {
  const p = tzParts(date);
  return tzInstant(p.y, p.mo, p.d, 23, 59, 59, 999);
}

function startOfMonth(year: number, month: number): Date {
  return tzInstant(year, month, 1, 0, 0, 0, 0);
}

function endOfMonth(year: number, month: number): Date {
  // День 0 следующего месяца = последний день месяца `month`.
  return tzInstant(year, month + 1, 0, 23, 59, 59, 999);
}

export function resolvePreset(preset: PeriodPreset, now: Date = new Date()): Period {
  const { y, mo: m, d } = tzParts(now);
  switch (preset) {
    case 'this-month':
      return { from: startOfMonth(y, m), to: endOfDay(now) };
    case 'prev-month':
      return { from: startOfMonth(y, m - 1), to: endOfMonth(y, m - 1) };
    case 'this-quarter': {
      const q = Math.floor(m / 3);
      return { from: startOfMonth(y, q * 3), to: endOfDay(now) };
    }
    case 'prev-quarter': {
      const q = Math.floor(m / 3);
      // Предыдущий квартал: на 3 месяца назад от начала текущего (нормализация
      // через Date.UTC сама уводит в прошлый год при q=0).
      return { from: startOfMonth(y, q * 3 - 3), to: endOfMonth(y, q * 3 - 1) };
    }
    case 'this-year':
    case 'ytd':
      return { from: startOfMonth(y, 0), to: endOfDay(now) };
    case 'prev-year':
      return { from: startOfMonth(y - 1, 0), to: endOfMonth(y - 1, 11) };
    case 'last-30d':
      return { from: tzInstant(y, m, d - 29, 0, 0, 0, 0), to: endOfDay(now) };
    case 'last-90d':
      return { from: tzInstant(y, m, d - 89, 0, 0, 0, 0), to: endOfDay(now) };
    case 'last-12m':
      return { from: startOfMonth(y, m - 11), to: endOfDay(now) };
  }
}

export interface PeriodInput {
  preset?: PeriodPreset;
  from?: string;
  to?: string;
}

export function resolvePeriod(input: PeriodInput, now: Date = new Date()): Period {
  if (input.preset) return resolvePreset(input.preset, now);
  if (input.from && input.to) {
    const from = startOfDay(new Date(input.from));
    const to = endOfDay(new Date(input.to));
    // M2: инвертированный диапазон → явная ошибка, а не тихий пустой отчёт.
    if (from.getTime() > to.getTime()) {
      throw new BadRequestException('Период: дата начала позже даты конца');
    }
    return { from, to };
  }
  return resolvePreset('this-month', now);
}

export interface ComparisonInput {
  mode: CompareMode;
  from?: string;
  to?: string;
  /** Пресет primary-периода — для КАЛЕНДАРНОГО prev (M1). */
  preset?: PeriodPreset;
}

/** this-* пресет → соответствующий prev-* (для календарного сравнения 'prev'). */
const PREV_OF: Partial<Record<PeriodPreset, PeriodPreset>> = {
  'this-month': 'prev-month',
  'this-quarter': 'prev-quarter',
  'this-year': 'prev-year',
  ytd: 'prev-year',
};

/**
 * 'prev' = предыдущий период. Для календарных пресетов (this-month/quarter/year,
 * ytd) — ПРЕДЫДУЩИЙ КАЛЕНДАРНЫЙ период (M1: иначе MoM сравнивал бы с «N дней до»,
 * а не с прошлым месяцем). Для остальных (last-30d и кастома) — диапазон той же
 * длины прямо перед primary. 'yoy' = тот же диапазон на год назад (календарно).
 */
export function resolveComparison(
  primary: Period,
  input: ComparisonInput,
  now: Date = new Date(),
): Period | null {
  if (input.mode === 'none') return null;
  if (input.mode === 'custom') {
    if (!input.from || !input.to) return null;
    const from = startOfDay(new Date(input.from));
    const to = endOfDay(new Date(input.to));
    // M2 (симметрично resolvePeriod): инвертированный диапазон сравнения → ошибка.
    if (from.getTime() > to.getTime()) {
      throw new BadRequestException('Период сравнения: дата начала позже даты конца');
    }
    return { from, to };
  }
  if (input.mode === 'yoy') {
    const f = tzParts(primary.from);
    const t = tzParts(primary.to);
    // Сдвиг на календарный год назад с сохранением времени суток границы.
    return {
      from: new Date(primary.from.getTime() - yearShiftMs(f.y)),
      to: new Date(primary.to.getTime() - yearShiftMs(t.y)),
    };
  }
  // prev
  if (input.preset && PREV_OF[input.preset]) {
    return resolvePreset(PREV_OF[input.preset]!, now);
  }
  // По длине: диапазон такой же длины, заканчивающийся прямо перед primary.from.
  const lengthMs = primary.to.getTime() - primary.from.getTime();
  const to = new Date(primary.from.getTime() - 1);
  const from = new Date(to.getTime() - lengthMs);
  return { from, to };
}

/** Длительность года (в мс), предшествующего году y — учитывает високосность. */
function yearShiftMs(y: number): number {
  const isLeap = (y - 1) % 4 === 0 && ((y - 1) % 100 !== 0 || (y - 1) % 400 === 0);
  return (isLeap ? 366 : 365) * 24 * 60 * 60 * 1000;
}

export function enumerateMonths(period: Period): { from: Date; to: Date; label: string }[] {
  const result: { from: Date; to: Date; label: string }[] = [];
  const start = tzParts(period.from);
  const end = tzParts(period.to);
  let y = start.y;
  let m = start.mo;
  while (y < end.y || (y === end.y && m <= end.mo)) {
    const from = startOfMonth(y, m);
    const to = endOfMonth(y, m);
    const cappedFrom = from < period.from ? period.from : from;
    const cappedTo = to > period.to ? period.to : to;
    result.push({
      from: cappedFrom,
      to: cappedTo,
      label: `${y}-${String(m + 1).padStart(2, '0')}`,
    });
    m++;
    if (m > 11) {
      m = 0;
      y++;
    }
  }
  return result;
}

export function enumerateQuarters(period: Period): { from: Date; to: Date; label: string }[] {
  const result: { from: Date; to: Date; label: string }[] = [];
  const start = tzParts(period.from);
  const end = tzParts(period.to);
  let y = start.y;
  let q = Math.floor(start.mo / 3);
  const endQ = Math.floor(end.mo / 3);
  while (y < end.y || (y === end.y && q <= endQ)) {
    const from = startOfMonth(y, q * 3);
    const to = endOfMonth(y, q * 3 + 2);
    const cappedFrom = from < period.from ? period.from : from;
    const cappedTo = to > period.to ? period.to : to;
    result.push({ from: cappedFrom, to: cappedTo, label: `${y}-Q${q + 1}` });
    q++;
    if (q > 3) {
      q = 0;
      y++;
    }
  }
  return result;
}
