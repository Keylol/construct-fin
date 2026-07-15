import { businessDayParts, businessInstant } from '../reports/period';

/**
 * Ф5. Чистый генератор дат вхождений регулярного платежа в поясе бизнеса (UTC+5).
 * Вынесен из сервиса, чтобы покрыть юнит-тестами без БД: логика клампа дня к длине
 * месяца и попадания в окно — самое хрупкое место материализации.
 */

export interface RecurrenceRule {
  cadence: 'MONTHLY' | 'WEEKLY';
  /** MONTHLY: 1..31 (клампится к длине месяца, 31 → 28/29/30). */
  dayOfMonth: number | null;
  /** WEEKLY: 0=вс..6=сб (в поясе бизнеса). */
  weekday: number | null;
  startDate: Date;
  endDate: Date | null;
}

/** Число дней в месяце mo0 (0..11) года y. День 0 следующего месяца. */
function daysInMonth(y: number, mo0: number): number {
  return new Date(Date.UTC(y, mo0 + 1, 0)).getUTCDate();
}

/** Сравнимый номер календарного дня YYYYMMDD в поясе бизнеса. */
function dayNum(date: Date): number {
  const p = businessDayParts(date);
  return p.y * 10000 + (p.mo + 1) * 100 + p.d;
}

/**
 * Даты вхождений правила в окне [windowStart, windowEnd] (включительно),
 * канонично на полдень бизнес-времени. Отфильтрованы диапазоном startDate/endDate
 * самого правила (по календарному дню, без учёта времени суток). Результат
 * отсортирован по возрастанию; при некорректных полях правила — пустой массив.
 */
export function recurrenceOccurrences(
  rule: RecurrenceRule,
  windowStart: Date,
  windowEnd: Date,
): Date[] {
  const out: Date[] = [];
  const wStart = windowStart.getTime();
  const wEnd = windowEnd.getTime();
  if (wStart > wEnd) return out;

  const startDay = dayNum(rule.startDate);
  const endDay = rule.endDate ? dayNum(rule.endDate) : null;

  const withinRule = (occ: Date): boolean => {
    const dn = dayNum(occ);
    if (dn < startDay) return false;
    if (endDay !== null && dn > endDay) return false;
    const t = occ.getTime();
    return t >= wStart && t <= wEnd;
  };

  if (rule.cadence === 'MONTHLY') {
    const day = rule.dayOfMonth;
    if (day == null || day < 1 || day > 31) return out;
    // Перебираем месяцы от начала окна до конца включительно (с запасом ±1).
    const s = businessDayParts(windowStart);
    const e = businessDayParts(windowEnd);
    let y = s.y;
    let mo = s.mo;
    // Safety-предел итераций (окно материализации ограничено ~месяцами).
    for (let i = 0; i < 400 && (y < e.y || (y === e.y && mo <= e.mo)); i++) {
      const clamped = Math.min(day, daysInMonth(y, mo));
      const occ = businessInstant(y, mo, clamped, 12);
      if (withinRule(occ)) out.push(occ);
      mo++;
      if (mo > 11) {
        mo = 0;
        y++;
      }
    }
    return out;
  }

  // WEEKLY: перебираем дни окна, отбираем нужный день недели (в поясе бизнеса).
  const wd = rule.weekday;
  if (wd == null || wd < 0 || wd > 6) return out;
  const s = businessDayParts(windowStart);
  // Идём по календарным дням через businessInstant (нормализует переполнение дня).
  for (let i = 0; i < 800; i++) {
    const occ = businessInstant(s.y, s.mo, s.d + i, 12);
    if (occ.getTime() > wEnd) break;
    const p = businessDayParts(occ);
    const dow = new Date(Date.UTC(p.y, p.mo, p.d)).getUTCDay();
    if (dow === wd && withinRule(occ)) out.push(occ);
  }
  return out;
}
