import { rangeFor } from '@/lib/periods';
import type { ActiveFilters } from '@/components/transactions/TransactionFilters';
import type { TxType } from '@/lib/types';

/**
 * URL ↔ фильтры списка операций (drill-down из отчётов/карточек).
 *
 * Контракт query-параметров: from, to (ISO, точные границы периода из отчёта),
 * accountId, categoryId, counterpartyId, type (INCOME|EXPENSE). `period` в URL НЕ
 * кладём — при явных from/to выставляем period:'all', чтобы пресет rangeFor не
 * перезаписал диапазон. `search` в URL не выносим (эфемерный ввод).
 *
 * Один источник имён для приёмника (/transactions) и источников (отчёты/карточки).
 */

/** Собрать query-строку из активных фильтров (для router.replace / Link href). */
export function filtersToSearchParams(active: ActiveFilters): string {
  const sp = new URLSearchParams();
  if (active.range.from) sp.set('from', active.range.from);
  if (active.range.to) sp.set('to', active.range.to);
  if (active.accountId) sp.set('accountId', active.accountId);
  if (active.categoryId) sp.set('categoryId', active.categoryId);
  if (active.counterpartyId) sp.set('counterpartyId', active.counterpartyId);
  if (active.type) sp.set('type', active.type);
  return sp.toString();
}

/** Разобрать фильтры из URL. Дефолт (пустой URL) = текущий месяц. */
export function searchParamsToFilters(sp: URLSearchParams): ActiveFilters {
  const from = sp.get('from') || undefined;
  const to = sp.get('to') || undefined;
  const rawType = sp.get('type');
  // Тип валидируем по enum — мусор из URL отбрасываем.
  const type: TxType | undefined =
    rawType === 'INCOME' || rawType === 'EXPENSE' ? rawType : undefined;
  const accountId = sp.get('accountId') || undefined;
  const categoryId = sp.get('categoryId') || undefined;
  const counterpartyId = sp.get('counterpartyId') || undefined;

  // from > to → API вернёт 400 (assertFromBeforeTo). Невалидную пару отбрасываем.
  const validRange = from && to ? from <= to : true;

  if ((from || to) && validRange) {
    return {
      period: 'all',
      range: { from, to },
      accountId,
      categoryId,
      counterpartyId,
      type,
    };
  }
  // Нет диапазона в URL — дефолт «этот месяц», но фильтры-измерения уважаем.
  return {
    period: 'month',
    range: rangeFor('month'),
    accountId,
    categoryId,
    counterpartyId,
    type,
  };
}

/**
 * Построить href в /transactions с точным периодом отчёта и одним измерением.
 * from/to — резолвленные ISO из ОТВЕТА отчёта (не из PeriodPicker).
 */
export function txDrilldownHref(params: {
  from?: string;
  to?: string;
  accountId?: string;
  categoryId?: string;
  counterpartyId?: string;
  type?: TxType;
}): string {
  const sp = new URLSearchParams();
  if (params.from) sp.set('from', params.from);
  if (params.to) sp.set('to', params.to);
  if (params.accountId) sp.set('accountId', params.accountId);
  if (params.categoryId) sp.set('categoryId', params.categoryId);
  if (params.counterpartyId) sp.set('counterpartyId', params.counterpartyId);
  if (params.type) sp.set('type', params.type);
  const qs = sp.toString();
  return qs ? `/transactions?${qs}` : '/transactions';
}
