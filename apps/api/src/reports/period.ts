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
/** IJ12: максимальная ширина кастомного диапазона отчёта — 5 лет. */
const MAX_PERIOD_MS = 5 * 366 * 24 * 60 * 60 * 1000;

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
 * L12: календарный год момента в поясе бизнеса (UTC+5). Для номеров/последовательностей,
 * привязанных к году (ORD-YYYY-NNNN). Сервер в контейнере обычно UTC — голый
 * `new Date().getFullYear()` на стыке года ~5 часов вернул бы прошлый год.
 */
export function businessYear(at: Date = new Date()): number {
  return tzParts(at).y;
}

/** Y/M/D + время суток момента в поясе бизнеса (UTC+5). */
function tzPartsTime(date: Date) {
  const s = new Date(date.getTime() + OFFSET_MS);
  return {
    y: s.getUTCFullYear(),
    mo: s.getUTCMonth(),
    d: s.getUTCDate(),
    h: s.getUTCHours(),
    mi: s.getUTCMinutes(),
    s: s.getUTCSeconds(),
    ms: s.getUTCMilliseconds(),
  };
}

/**
 * Сдвиг момента на целое число лет КАЛЕНДАРНО в поясе бизнеса (UTC+5), сохраняя
 * месяц/день/время суток границы. Календарный сдвиг (а НЕ вычитание фиксированных
 * 365/366 мс) корректен вокруг високосного года — иначе YoY-граница уезжала на
 * сутки (M2). Date.UTC нормализует несуществующее 29 фев → 1 мар.
 */
function shiftYearsTz(date: Date, deltaYears: number): Date {
  const p = tzPartsTime(date);
  const shifted = tzInstant(p.y + deltaYears, p.mo, p.d, p.h, p.mi, p.s, p.ms);
  // Граничный случай 29 фев: в невисокосном целевом году Date.UTC нормализовал
  // бы несуществующее 29 фев ВПЕРЁД (→ 1 мар), снова смещая YoY-границу на сутки.
  // При «уехавшей» дате клампим к последнему дню целевого месяца (28 фев):
  // tzInstant(y, mo+1, 0) → день 0 = последний день месяца mo.
  const sp = tzPartsTime(shifted);
  if (sp.d !== p.d || sp.mo !== p.mo) {
    return tzInstant(p.y + deltaYears, p.mo + 1, 0, p.h, p.mi, p.s, p.ms);
  }
  return shifted;
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

/** Начало суток (00:00:00.000) даты в поясе бизнеса (UTC+5). */
export function startOfDay(date: Date): Date {
  const p = tzParts(date);
  return tzInstant(p.y, p.mo, p.d, 0, 0, 0, 0);
}

/** Конец суток (23:59:59.999) даты в поясе бизнеса (UTC+5). */
export function endOfDay(date: Date): Date {
  const p = tzParts(date);
  return tzInstant(p.y, p.mo, p.d, 23, 59, 59, 999);
}

/**
 * DE4: дата денежной операции не может быть в будущем. «Сегодня» — конец
 * текущих суток в поясе бизнеса (UTC+5), чтобы «сегодняшняя» дата в любом
 * часовом поясе клиента не отсекалась. Прошлое разрешено (бэкдейт вчерашнего
 * платежа/закупки — норма); будущее — почти всегда опечатка, сажающая проводку
 * в ещё не наступивший период отчёта. Бросает BadRequestException (400).
 */
export function assertNotFuture(date: Date, label: string): void {
  if (date.getTime() > endOfDay(new Date()).getTime()) {
    throw new BadRequestException(`${label} не может быть в будущем`);
  }
}

function startOfMonth(year: number, month: number): Date {
  return tzInstant(year, month, 1, 0, 0, 0, 0);
}

function endOfMonth(year: number, month: number): Date {
  // День 0 следующего месяца = последний день месяца `month`.
  return tzInstant(year, month + 1, 0, 23, 59, 59, 999);
}

/** Календарный год [1 янв .. 31 дек] в поясе бизнеса (UTC+5). Для вкладки «Налог». */
export function yearPeriod(year: number): Period {
  return { from: startOfMonth(year, 0), to: endOfMonth(year, 11) };
}

/** Метка бизнес-месяца момента: «YYYY-MM» (UTC+5). Ключ помесячной группировки. */
export function businessMonthLabel(date: Date): string {
  const { y, mo } = tzParts(date);
  return `${y}-${String(mo + 1).padStart(2, '0')}`;
}

/**
 * Ф5. Y/M/D момента в поясе бизнеса (UTC+5). Экспорт для генератора регулярки:
 * из даты вхождения нужны календарные компоненты в поясе бизнеса, а не сервера.
 */
export function businessDayParts(date: Date): { y: number; mo: number; d: number } {
  return tzParts(date);
}

/**
 * Ф5. UTC-инстант, чьи стенные часы в UTC+5 = (y, mo0, d) в указанный час (по
 * умолчанию полдень). Полдень — канонический инстант даты платежа: ISO-дата
 * стабильна (не «уезжает» на сутки из-за смещения +5), а идемпотентность
 * материализации (recurringId+dueDate) держится на точном равенстве инстанта.
 */
export function businessInstant(y: number, mo0: number, d: number, hour = 12): Date {
  return tzInstant(y, mo0, d, hour, 0, 0, 0);
}

/** Срок уплаты налога АУСН за месяц — 25-е число СЛЕДУЮЩЕГО месяца (UTC+5). */
export function ausnDueDate(year: number, month1to12: number): Date {
  // month1to12: 1..12 → mo=month-1; следующий месяц = mo+1 (Date.UTC нормализует).
  // Полдень бизнес-времени: ISO-дата (UTC) не «уезжает» на 24-е из-за смещения +5.
  return tzInstant(year, month1to12, 25, 12, 0, 0, 0);
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
    // IJ12: ширина ограничена — иначе O(месяцев) слайсов и многомегабайтный JSON
    // на аутентифицированном GET без троттлинга (перф/DoS-соседство).
    if (to.getTime() - from.getTime() > MAX_PERIOD_MS) {
      throw new BadRequestException('Период слишком широкий (максимум 5 лет)');
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

/**
 * IJ5: календарная гранулярность пресета в месяцах — для КАЛЕНДАРНОГО prev.
 * Раньше был PREV_OF (this-* → prev-*), но он не покрывал prev-month/quarter/year
 * КАК PRIMARY (их предлагает PeriodPicker) → они падали в by-length fallback,
 * дававший окно, не совпадающее с границами месяца (у месяцев разное число дней).
 * Теперь prev-период считается арифметикой месяцев для ЛЮБОГО календарного пресета.
 */
const CAL_PREV_MONTHS: Partial<Record<PeriodPreset, number>> = {
  'this-month': 1,
  'prev-month': 1,
  'this-quarter': 3,
  'prev-quarter': 3,
  'this-year': 12,
  'prev-year': 12,
  ytd: 12,
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
    // IJ12 (симметрично resolvePeriod): ширина сравнения тоже ограничена — иначе
    // DoS через compareFrom/compareTo в обход лимита primary-периода.
    if (to.getTime() - from.getTime() > MAX_PERIOD_MS) {
      throw new BadRequestException('Период сравнения слишком широкий (максимум 5 лет)');
    }
    return { from, to };
  }
  if (input.mode === 'yoy') {
    // M2: тот же интервал на КАЛЕНДАРНЫЙ год назад в поясе бизнеса (сохраняем
    // месяц/день/время суток). Вычитание фиксированных 365/366 мс смещало
    // границу на сутки вокруг високосного года.
    return {
      from: shiftYearsTz(primary.from, -1),
      to: shiftYearsTz(primary.to, -1),
    };
  }
  // prev
  // IJ5: для календарных пресетов — предыдущий КАЛЕНДАРНЫЙ период, собранный из
  // компонент (а не сдвигом миллисекунд): начало = 1-е число (месяц − N), конец =
  // последний день месяца, предшествующего primary (tzInstant(y, mo, 0) = день 0
  // месяца mo = последний день mo−1). Корректно для month/quarter/year и для
  // prev-* как primary; уважает разное число дней в месяцах.
  const nMonths = input.preset ? CAL_PREV_MONTHS[input.preset] : undefined;
  if (nMonths) {
    const p = tzParts(primary.from);
    return {
      from: tzInstant(p.y, p.mo - nMonths, 1, 0, 0, 0, 0),
      to: tzInstant(p.y, p.mo, 0, 23, 59, 59, 999),
    };
  }
  // По длине: диапазон такой же длины, заканчивающийся прямо перед primary.from
  // (для last-30d/90d и кастома — периодов без календарной гранулярности).
  const lengthMs = primary.to.getTime() - primary.from.getTime();
  const to = new Date(primary.from.getTime() - 1);
  const from = new Date(to.getTime() - lengthMs);
  return { from, to };
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
