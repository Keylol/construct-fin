import { D } from '@construct/shared';
// Относительные импорты: модуль покрыт юнит-тестами, а vitest веба алиас «@» не знает.
import { MONTH_NAMES } from './labels';
import type { MonthSummaryReport } from './types';

/**
 * Хелперы «Итогов месяца»: месяц в поясе бизнеса, короткие суммы для текста
 * («3,3 млн ₽»), изменение к прошлому месяцу, полоса «из 100 ₽» и шаги
 * «на один компьютер». Без React — покрыто month-summary.test.ts.
 */

// Месяц считаем в поясе бизнеса UTC+5, как бэк (apps/api/src/reports/period.ts):
// в 00:30 первого числа по Екатеринбургу прошлый месяц уже закончен, где бы ни
// был браузер.
const OFFSET_MS = 5 * 60 * 60_000;
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function isMonth(value: string): boolean {
  return MONTH_RE.test(value);
}

/** Текущий месяц бизнеса «YYYY-MM». */
export function businessMonth(now: Date = new Date()): string {
  const s = new Date(now.getTime() + OFFSET_MS);
  return `${s.getUTCFullYear()}-${String(s.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + delta;
  const ny = Math.floor(idx / 12);
  return `${ny}-${String(idx - ny * 12 + 1).padStart(2, '0')}`;
}

/** Прошлый законченный месяц — по умолчанию на экране. */
export function lastClosedMonth(now: Date = new Date()): string {
  return shiftMonth(businessMonth(now), -1);
}

function monthIndex(month: string): number {
  return Number(month.slice(5, 7)) - 1;
}

/** «Август 2026» — заголовок выбора месяца. */
export function monthTitle(month: string): string {
  return `${MONTH_NAMES[monthIndex(month)]} ${month.slice(0, 4)}`;
}

/** «август» — для «за август». */
export function monthName(month: string): string {
  return (MONTH_NAMES[monthIndex(month)] ?? '').toLowerCase();
}

const MONTH_DATIVE = [
  'январю',
  'февралю',
  'марту',
  'апрелю',
  'маю',
  'июню',
  'июлю',
  'августу',
  'сентябрю',
  'октябрю',
  'ноябрю',
  'декабрю',
] as const;

/** «июлю» — для «+12 % к июлю». */
export function monthDative(month: string): string {
  return MONTH_DATIVE[monthIndex(month)] ?? '';
}

const numberFormat = (fractionDigits: number) =>
  new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });

/** Число с разрядами и запятой; «,0» в конце убираем: «3,3», «48», «1 250». */
function formatCompactNumber(value: string, fractionDigits: number): string {
  const text = numberFormat(fractionDigits).format(Number(value));
  return text.replace(/,0+$/, '');
}

/**
 * Сумма для текста, а не для колонки: «3,3 млн ₽», «48,5 тыс. ₽», «950 ₽».
 * Минус — знаком «−»; в колонках суммы по-прежнему через Money.
 */
export function formatRubShort(value: string | number): string {
  const v = D(value);
  const abs = v.abs();
  const sign = v.lt(0) ? '−' : '';
  if (abs.gte(1_000_000)) {
    return `${sign}${formatCompactNumber(abs.div(1_000_000).toFixed(1), 1)}\u00A0млн\u00A0₽`;
  }
  if (abs.gte(100_000)) {
    return `${sign}${formatCompactNumber(abs.div(1000).toFixed(0), 0)}\u00A0тыс.\u00A0₽`;
  }
  if (abs.gte(1000)) {
    return `${sign}${formatCompactNumber(abs.div(1000).toFixed(1), 1)}\u00A0тыс.\u00A0₽`;
  }
  return `${sign}${formatCompactNumber(abs.toFixed(0), 0)}\u00A0₽`;
}

/** Рублей из 100 ₽ продаж: «74,0»; отрицательное — в скобках, как деньги в приложении. */
export function formatPer100(value: string): string {
  const text = numberFormat(1).format(Math.abs(Number(value)));
  return D(value).lt(0) ? `(${text})` : text;
}

/**
 * Изменение к прошлому месяцу: «+1,2 млн ₽ (+22 %) к июлю». Процент — только
 * от положительной базы: от убытка он ничего не говорит.
 */
export function deltaText(current: string, previous: string, previousMonth: string): string {
  const d = D(current).minus(previous);
  const to = `к ${monthDative(previousMonth)}`;
  if (d.isZero()) return `без изменений ${to}`;
  const sign = d.gt(0) ? '+' : '−';
  let pct = '';
  if (D(previous).gt(0)) {
    const p = d.abs().div(previous).times(100);
    const digits = p.lt(10) ? 1 : 0;
    const text = numberFormat(digits).format(Number(p.toFixed(digits)));
    pct = ` (${sign}${text}\u00A0%)`;
  }
  return `${sign}${formatRubShort(d.abs().toFixed(2))}${pct} ${to}`;
}

export interface BarParts {
  /** Рублей из 100: комплектующие, расходы за вычетом прочих доходов, прибыль. */
  components: string;
  expenses: string;
  net: string;
  /** Ширины частей полосы в процентах (убыток части не получает). */
  widths: [number, number, number];
}

/**
 * Полоса «из каждых 100 ₽»: комплектующие / расходы / прибыль. Прочие доходы
 * вычитаются из расходов, поэтому три части складываются ровно в 100.
 * При убытке полоса — комплектующие и расходы, их сумма больше 100.
 */
export function barParts(r: MonthSummaryReport): BarParts | null {
  if (!r.per100 || r.netPct === null) return null;
  const components = D(r.per100.components);
  const expenses = D(r.per100.expenses).minus(r.per100.otherIncome);
  const net = D(r.netPct);
  const segs = [components, expenses, net].map((x) => (x.gt(0) ? x : D(0)));
  const total = segs.reduce((s, x) => s.plus(x), D(0));
  const widths = segs.map((x) =>
    total.gt(0) ? Number(x.div(total).times(100).toFixed(2)) : 0,
  ) as [number, number, number];
  return {
    components: components.toFixed(1),
    expenses: expenses.toFixed(1),
    net: net.toFixed(1),
    widths,
  };
}

export interface PerOrderStep {
  key: string;
  /** Знак шага: вычитаем, прибавляем или подводим итог. */
  op: '' | '−' | '+' | '=';
  label: string;
  value: string;
  total?: boolean;
}

/**
 * «На один компьютер»: продажа → комплектующие → наценка → крупнейшие группы
 * → остальные расходы → прочие доходы → прибыль. Суммы на заказ приходят с
 * бэка уже согласованными (наибольшие остатки), поэтому шаги складываются.
 */
export function perOrderSteps(r: MonthSummaryReport, top = 3): PerOrderStep[] | null {
  if (!r.perOrder || r.netPerOrder === null) return null;
  const steps: PerOrderStep[] = [
    { key: 'sales', op: '', label: 'Продажа', value: r.perOrder.sales },
    { key: 'components', op: '−', label: 'Комплектующие', value: r.perOrder.components },
    { key: 'markup', op: '=', label: 'Наценка', value: r.perOrder.markup, total: true },
  ];
  const live = r.groups.filter((g) => !D(g.amount).isZero());
  for (const g of live.slice(0, top)) {
    steps.push({ key: `group:${g.key}`, op: '−', label: g.name, value: g.perOrder ?? '0' });
  }
  const rest = live.slice(top);
  if (rest.length > 0) {
    const value = rest.reduce((s, g) => s.plus(g.perOrder ?? '0'), D(0)).toFixed(0);
    steps.push({ key: 'rest', op: '−', label: `Остальные расходы (${rest.length})`, value });
  }
  if (!D(r.perOrder.otherIncome).isZero()) {
    steps.push({ key: 'other', op: '+', label: 'Прочие доходы', value: r.perOrder.otherIncome });
  }
  steps.push({ key: 'net', op: '=', label: 'Прибыль', value: r.netPerOrder, total: true });
  return steps;
}
