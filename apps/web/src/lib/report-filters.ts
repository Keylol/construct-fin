import type { UrlCodec } from '@/hooks/useUrlFilters';
import type { PeriodParams } from '@/hooks/useReports';
import { ANY_PERIOD_LABELS, rangeForAny, type AnyPeriod, type DateRange } from '@/lib/periods';
import type { PeriodPreset } from '@/lib/types';

/**
 * Период отчёта: тот же словарь пресетов, что у списка операций (`AnyPeriod`),
 * плюс явные границы. «Свой диапазон» — это `period: 'all'` с заполненными
 * from/to: ровно так список операций понимает правку полей «С»/«По», поэтому
 * ссылка из отчёта в операции и обратно несёт один и тот же разрез.
 */
export interface ReportPeriod {
  period: AnyPeriod;
  range: DateRange;
}

const PRESETS: readonly PeriodPreset[] = [
  'this-month',
  'prev-month',
  'this-quarter',
  'prev-quarter',
  'this-year',
  'prev-year',
  'ytd',
  'last-30d',
  'last-90d',
  'last-12m',
];

export function isPeriodPreset(p: AnyPeriod): p is PeriodPreset {
  return (PRESETS as readonly string[]).includes(p);
}

export function reportPeriod(period: AnyPeriod): ReportPeriod {
  return { period, range: rangeForAny(period) };
}

/**
 * Период → параметры API. Пресет уходит как есть — границы считает бэкенд
 * (`resolvePreset`, зеркало `rangeForPreset`), остальное («сегодня», «неделя»,
 * свой диапазон) — явными from/to.
 */
export function toPeriodParams(p: ReportPeriod): PeriodParams {
  if (isPeriodPreset(p.period)) return { preset: p.period };
  return { from: p.range.from, to: p.range.to };
}

type Extras = Record<string, string>;

/**
 * Кодек адреса отчёта: `period` (пресет) либо `from`/`to` (свой диапазон) плюс
 * плоские измерения отчёта (группировка, тип, счёт, разрез). Значение, равное
 * умолчанию, в адрес не пишется. Мусор в `period` и перевёрнутый диапазон
 * отбрасываются в умолчание — отчёт не должен падать от ссылки.
 */
export function reportCodec<E extends Extras>(
  defaultPeriod: AnyPeriod,
  extras: E,
): UrlCodec<ReportPeriod & E> {
  const extraKeys = Object.keys(extras);
  return {
    keys: ['period', 'from', 'to', ...extraKeys],
    parse: (sp) => {
      const from = sp.get('from') || undefined;
      const to = sp.get('to') || undefined;
      const rawPeriod = sp.get('period');
      const out: Extras = { ...extras };
      for (const k of extraKeys) {
        const v = sp.get(k);
        if (v !== null) out[k] = v;
      }
      let p: ReportPeriod;
      if ((from || to) && (!from || !to || from <= to)) {
        p = { period: 'all', range: { from, to } };
      } else if (rawPeriod && rawPeriod !== 'all' && rawPeriod in ANY_PERIOD_LABELS) {
        p = reportPeriod(rawPeriod as AnyPeriod);
      } else {
        p = reportPeriod(defaultPeriod);
      }
      return { ...p, ...(out as E) };
    },
    serialize: (v) => {
      const sp = new URLSearchParams();
      if (v.period === 'all') {
        if (v.range.from) sp.set('from', v.range.from);
        if (v.range.to) sp.set('to', v.range.to);
      } else if (v.period !== defaultPeriod) {
        sp.set('period', v.period);
      }
      for (const k of extraKeys) {
        const val = (v as unknown as Extras)[k];
        if (val !== undefined && val !== extras[k] && val !== '') sp.set(k, val);
      }
      return sp;
    },
  };
}
