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

function startOfMonth(year: number, month: number): Date {
  return startOfDay(new Date(year, month, 1));
}

function endOfMonth(year: number, month: number): Date {
  return endOfDay(new Date(year, month + 1, 0));
}

export function resolvePreset(preset: PeriodPreset, now: Date = new Date()): Period {
  const y = now.getFullYear();
  const m = now.getMonth();
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
      const prevQStart = q === 0 ? new Date(y - 1, 9, 1) : new Date(y, (q - 1) * 3, 1);
      const prevQEnd = q === 0 ? new Date(y - 1, 12, 0) : new Date(y, q * 3, 0);
      return { from: startOfDay(prevQStart), to: endOfDay(prevQEnd) };
    }
    case 'this-year':
    case 'ytd':
      return { from: startOfMonth(y, 0), to: endOfDay(now) };
    case 'prev-year':
      return { from: startOfMonth(y - 1, 0), to: endOfMonth(y - 1, 11) };
    case 'last-30d': {
      const from = new Date(now);
      from.setDate(now.getDate() - 29);
      return { from: startOfDay(from), to: endOfDay(now) };
    }
    case 'last-90d': {
      const from = new Date(now);
      from.setDate(now.getDate() - 89);
      return { from: startOfDay(from), to: endOfDay(now) };
    }
    case 'last-12m': {
      const from = new Date(y, m - 11, 1);
      return { from: startOfDay(from), to: endOfDay(now) };
    }
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
    return { from: startOfDay(new Date(input.from)), to: endOfDay(new Date(input.to)) };
  }
  return resolvePreset('this-month', now);
}

export interface ComparisonInput {
  mode: CompareMode;
  from?: string;
  to?: string;
}

/**
 * 'prev' = диапазон такой же длины, заканчивающийся прямо перед primary.from.
 * 'yoy'  = тот же диапазон, сдвинутый на 1 год назад.
 */
export function resolveComparison(
  primary: Period,
  input: ComparisonInput,
): Period | null {
  if (input.mode === 'none') return null;
  if (input.mode === 'custom') {
    if (!input.from || !input.to) return null;
    return { from: startOfDay(new Date(input.from)), to: endOfDay(new Date(input.to)) };
  }
  if (input.mode === 'yoy') {
    const from = new Date(primary.from);
    from.setFullYear(from.getFullYear() - 1);
    const to = new Date(primary.to);
    to.setFullYear(to.getFullYear() - 1);
    return { from, to };
  }
  // prev
  const lengthMs = primary.to.getTime() - primary.from.getTime();
  const to = new Date(primary.from.getTime() - 1);
  const from = new Date(to.getTime() - lengthMs);
  return { from, to };
}

export function enumerateMonths(period: Period): { from: Date; to: Date; label: string }[] {
  const result: { from: Date; to: Date; label: string }[] = [];
  let y = period.from.getFullYear();
  let m = period.from.getMonth();
  const endY = period.to.getFullYear();
  const endM = period.to.getMonth();
  while (y < endY || (y === endY && m <= endM)) {
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
  let y = period.from.getFullYear();
  let q = Math.floor(period.from.getMonth() / 3);
  const endY = period.to.getFullYear();
  const endQ = Math.floor(period.to.getMonth() / 3);
  while (y < endY || (y === endY && q <= endQ)) {
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
