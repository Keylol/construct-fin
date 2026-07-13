import type { ReportBucket } from '@/lib/types';

/**
 * Человекочитаемые названия P&L-бакетов — единые для ОПиУ «По группам»
 * и drill-down-фильтра на /transactions.
 */
export const BUCKET_LABEL: Record<ReportBucket, string> = {
  REVENUE: 'Выручка',
  COGS: 'Себестоимость',
  PURCHASES: 'Закупки', // IJ10: бакет закупок склада — раньше рендерился без названия
  FIXED: 'Постоянные',
  VARIABLE: 'Переменные',
  TAX: 'Налоги',
  CAPITAL: 'Капитал собственника',
  OTHER: 'Прочее',
};

/** Валидация bucket из URL — мусор отбрасываем (см. searchParamsToFilters). */
export function isReportBucket(v: string): v is ReportBucket {
  return v in BUCKET_LABEL;
}
