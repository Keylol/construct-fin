import { ANY_PERIOD_LABELS, rangeForAny, type AnyPeriod } from '@/lib/periods';
import { isReportBucket } from '@/lib/buckets';
import type { ActiveFilters } from '@/components/transactions/TransactionFilters';
import type { ReportBucket, TxType } from '@/lib/types';
import type { UrlCodec } from '@/hooks/useUrlFilters';
import { readStored, writeStored } from '@/lib/storage';

/**
 * URL ↔ фильтры списка операций (drill-down из отчётов/карточек, общий поиск).
 *
 * Контракт query-параметров: from, to (ISO, точные границы периода из отчёта),
 * accountId, categoryId, counterpartyId, type (INCOME|EXPENSE), bucket
 * (P&L-группа из ОПиУ «По группам»), q (поиск), period=all («Всё время» без
 * границ). Остальные пресеты периода в URL не кладём: при явных from/to
 * выставляем period:'all', чтобы пресет rangeFor не перезаписал диапазон.
 *
 * Поиск живёт в адресе, как на остальных экранах: F5 и «назад» его не теряют, а
 * «Показать все» из общего поиска приходит сюда уже с запросом и за все даты.
 *
 * Один источник имён для приёмника (/transactions) и источников (отчёты/карточки).
 */

/** Собрать query-строку из активных фильтров (для router.replace / Link href). */
export function filtersToSearchParams(active: ActiveFilters): string {
  const sp = new URLSearchParams();
  if (active.range.from) sp.set('from', active.range.from);
  if (active.range.to) sp.set('to', active.range.to);
  if (!active.range.from && !active.range.to && active.period === 'all') sp.set('period', 'all');
  if (active.accountId) sp.set('accountId', active.accountId);
  if (active.categoryId) sp.set('categoryId', active.categoryId);
  if (active.counterpartyId) sp.set('counterpartyId', active.counterpartyId);
  if (active.type) sp.set('type', active.type);
  if (active.bucket) sp.set('bucket', active.bucket);
  if (active.search) sp.set('q', active.search);
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
  const rawBucket = sp.get('bucket');
  // Бакет валидируем по словарю — мусор из URL отбрасываем.
  const bucket: ReportBucket | undefined =
    rawBucket && isReportBucket(rawBucket) ? rawBucket : undefined;
  const search = sp.get('q') || undefined;
  const dimensions = { accountId, categoryId, counterpartyId, type, bucket, search };

  // from > to → API вернёт 400 (assertFromBeforeTo). Невалидную пару отбрасываем.
  const validRange = from && to ? from <= to : true;

  if ((from || to) && validRange) {
    return { period: 'all', range: { from, to }, ...dimensions };
  }
  if (sp.get('period') === 'all') {
    return { period: 'all', range: rangeForAny('all'), ...dimensions };
  }
  // Нет диапазона в URL — дефолт «этот месяц», но фильтры-измерения уважаем.
  return { period: 'this-month', range: rangeForAny('this-month'), ...dimensions };
}

/** Кодек для useUrlFilters: те же parse/serialize, ключи — весь контракт выше. */
export const txFiltersCodec: UrlCodec<ActiveFilters> = {
  keys: ['from', 'to', 'period', 'accountId', 'categoryId', 'counterpartyId', 'type', 'bucket', 'q'],
  parse: searchParamsToFilters,
  serialize: (a) => new URLSearchParams(filtersToSearchParams(a)),
};

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
  bucket?: ReportBucket;
}): string {
  const sp = new URLSearchParams();
  if (params.from) sp.set('from', params.from);
  if (params.to) sp.set('to', params.to);
  if (params.accountId) sp.set('accountId', params.accountId);
  if (params.categoryId) sp.set('categoryId', params.categoryId);
  if (params.counterpartyId) sp.set('counterpartyId', params.counterpartyId);
  if (params.type) sp.set('type', params.type);
  if (params.bucket) sp.set('bucket', params.bucket);
  const qs = sp.toString();
  return qs ? `/transactions?${qs}` : '/transactions';
}

/**
 * Последний выбранный период списка операций.
 *
 * Помним ТОЛЬКО период: сотрудник неделями работает в одном месяце, и
 * возвращаться каждый раз в текущий — лишний клик на каждый заход. Измерения
 * (счёт, категория, контрагент, тип) не запоминаем: залипший фильтр читается
 * как «операций нет», а это уже класс ошибки, а не неудобство.
 *
 * Хранилище может быть недоступно (приватный режим) — не повод падать, как в
 * useTileView.
 */
const PERIOD_KEY = 'transactions:period';

export function readSavedPeriod(): AnyPeriod | null {
  const saved = readStored(PERIOD_KEY);
  // Старые ключи ('month'/'quarter'/'year') остались в словаре — сохранённый
  // до объединения выбор продолжает открываться тем же периодом.
  return saved && saved in ANY_PERIOD_LABELS ? (saved as AnyPeriod) : null;
}

export function writeSavedPeriod(key: AnyPeriod): void {
  writeStored(PERIOD_KEY, key);
}
