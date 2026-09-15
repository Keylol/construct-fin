'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Plus, ReceiptText } from '@/components/ui/icons';
import { LoadMore } from '@/components/ui/LoadMore';
import { Money } from '@/components/ui/Money';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useListHotkeys } from '@/hooks/useListHotkeys';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useAccounts } from '@/hooks/useAccounts';
import { useCategories } from '@/hooks/useCategories';
import { useCounterparties } from '@/hooks/useCounterparties';
import {
  useInfiniteTransactions,
  useTransactionSummary,
  type TransactionFilters as TF,
} from '@/hooks/useTransactions';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { KpiCard } from '@/components/ui/KpiCard';
import { KpiRow } from '@/components/ui/KpiRow';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { toast } from '@/components/ui/Toaster';
import {
  TransactionFilters,
  type ActiveFilters,
} from '@/components/transactions/TransactionFilters';
import { TransactionFormDialog } from '@/components/transactions/TransactionFormDialog';
import {
  filtersToSearchParams,
  readSavedPeriod,
  txFiltersCodec,
  writeSavedPeriod,
} from '@/lib/tx-filters';
import { useUrlFilters } from '@/hooks/useUrlFilters';
import { D, add, sub, toMoneyString } from '@construct/shared';
import { cn } from '@/lib/cn';
import type { Transaction } from '@/lib/types';
import { formatDate, formatDayLabel } from '@/lib/dates';
import { rangeForAny } from '@/lib/periods';

/**
 * Σ по строкам с учётом знака (доход +, расход −) — Decimal, без Number:
 * итоги дня в заголовках групп и «Итого по видимым» в подвале (№27/№28).
 */
function sumSigned(rows: Transaction[]): string {
  return toMoneyString(
    rows.reduce(
      (acc, t) => (t.type === 'INCOME' ? add(acc, t.amount) : sub(acc, t.amount)),
      D(0),
    ),
  );
}

// useSearchParams требует Suspense-границу на уровне page (Next 14 App Router).
export default function TransactionsPage() {
  return (
    <Suspense>
      <TransactionsView />
    </Suspense>
  );
}

function TransactionsView() {
  const { current } = useCurrentWorkspace();
  const wsId = current?.id ?? null;
  const accounts = useAccounts(wsId);
  const incomeCats = useCategories(wsId, 'INCOME');
  const expenseCats = useCategories(wsId, 'EXPENSE');
  const counterparties = useCounterparties(wsId);

  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Фильтры и поиск живут в адресе (drill-down из отчётов, общий поиск, F5, ссылка коллеге).
  const [filters, setFiltersInUrl] = useUrlFilters(txFiltersCodec);

  const setFilters = useCallback(
    (next: ActiveFilters) => {
      // Период запоминаем только когда его выбрал человек: возвращаться в
      // текущий месяц на каждом заходе — лишний клик, а работают неделями в
      // одном периоде. Измерения не помним (см. tx-filters).
      if (next.period !== filters.period) writeSavedPeriod(next.period);
      setFiltersInUrl(next);
    },
    [filters.period, setFiltersInUrl],
  );

  /**
   * Сохранённый период применяем после маунта: localStorage на сервере не
   * существует, а читать его в инициализаторе — рассинхрон гидратации.
   * Drill-down с явными from/to и «Всё время» из общего поиска главнее: там
   * период задал тот, кто прислал ссылку.
   */
  useEffect(() => {
    if (searchParams.get('from') || searchParams.get('to') || searchParams.get('period')) return;
    const saved = readSavedPeriod();
    if (!saved || saved === filters.period) return;
    setFiltersInUrl({ ...filters, period: saved, range: rangeForAny(saved) });
    // Разовый триггер на маунте — как в useCreateFromUrl.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // В инпуте — сырой filters.search, в запрос уходит значение после паузы в наборе.
  const debouncedSearch = useDebouncedValue(filters.search);

  const apiFilters: TF = useMemo(
    () => ({
      from: filters.range.from,
      to: filters.range.to,
      accountId: filters.accountId,
      categoryId: filters.categoryId,
      counterpartyId: filters.counterpartyId,
      type: filters.type,
      bucket: filters.bucket,
      search: debouncedSearch,
      limit: 100,
    }),
    [filters, debouncedSearch],
  );

  const txs = useInfiniteTransactions(wsId, apiFilters);
  const summary = useTransactionSummary(wsId, filters.range);

  const txRows = useMemo<Transaction[]>(
    () => txs.data?.pages.flatMap((p) => p.items) ?? [],
    [txs.data],
  );

  // «Ещё за другие даты»: поиск ищет в выбранном периоде (решение владельца
  // 13.09), а сервер на первой странице считает, сколько найдено вне его.
  const outsideCount = txs.data?.pages[0]?.outsideCount ?? null;
  const showAllDates = useCallback(() => {
    // Не через setFilters: «показать за все даты» — шаг поиска, а не выбор
    // периода, который стоит запомнить на следующий заход.
    setFiltersInUrl({ ...filters, period: 'all', range: rangeForAny('all') });
  }, [filters, setFiltersInUrl]);

  const [editingId, setEditingId] = useState<string | null>(null);
  // ?new=1 (из глобального «+ Создать») открывает форму создания сразу на маунте.
  const [creating, setCreating] = useState(() => searchParams.get('new') === '1');
  // «/» — в поиск, «n» — создать: список листают с клавиатуры.
  const searchRef = useRef<HTMLInputElement>(null);
  useListHotkeys({ searchRef, onNew: () => setCreating(true) });

  const closeForm = useCallback(() => {
    setCreating(false);
    setEditingId(null);
    // Убираем ?new из URL, чтобы refresh не переоткрыл форму.
    if (searchParams.get('new')) {
      const qs = filtersToSearchParams(filters);
      router.replace((qs ? `${pathname}?${qs}` : pathname) as Parameters<typeof router.replace>[0], {
        scroll: false,
      });
    }
  }, [searchParams, filters, pathname, router]);

  const allCats = useMemo(
    () => [...(incomeCats.data ?? []), ...(expenseCats.data ?? [])],
    [incomeCats.data, expenseCats.data],
  );
  const accountById = useMemo(
    () => Object.fromEntries((accounts.data ?? []).map((a) => [a.id, a])),
    [accounts.data],
  );
  const categoryById = useMemo(
    () => Object.fromEntries(allCats.map((c) => [c.id, c])),
    [allCats],
  );
  const counterpartyById = useMemo(
    () => Object.fromEntries((counterparties.data ?? []).map((c) => [c.id, c])),
    [counterparties.data],
  );

  if (!current) return null;

  // Колонка «Дата» ушла в заголовки дневных групп (№27); в mobileCards дата остаётся.
  const columns: Column<Transaction>[] = [
    {
      key: 'description',
      header: 'Описание',
      // w-full + max-w-0: без этого <td> в auto-layout растягивается по самому
      // длинному назначению банка (150+ символов), таблица уезжает за экран, а
      // колонка суммы обрезается. С max-w-0 ячейка берёт остаток ширины и
      // режет текст многоточием, как и задумано truncate ниже.
      className: 'w-full max-w-0',
      cell: (t) => {
        const cp = t.counterpartyId ? counterpartyById[t.counterpartyId] : undefined;
        const cat = t.categoryId ? categoryById[t.categoryId] : undefined;
        return (
          <div className="min-w-0">
            <div className="truncate font-medium text-foreground">
              {t.description?.trim() || cp?.name || cat?.name || (t.type === 'INCOME' ? 'Доход' : 'Расход')}
            </div>
            {(cp || cat) && (
              <div className="truncate text-xs text-muted-foreground">
                {[cat?.name, cp?.name].filter(Boolean).join(' · ')}
              </div>
            )}
          </div>
        );
      },
    },
    {
      key: 'account',
      header: 'Счёт',
      cell: (t) => (
        <span className="text-muted-foreground">{accountById[t.accountId]?.name ?? '—'}</span>
      ),
      className: 'w-[160px]',
    },
    {
      key: 'amount',
      header: 'Сумма',
      align: 'right',
      cell: (t) => (
        <span
          className={cn(
            'font-semibold tabular-nums',
            t.type === 'INCOME' ? 'text-success' : 'text-destructive',
          )}
        >
          {t.type === 'INCOME' ? '+' : '−'}
          <Money value={t.amount} tone="plain" />
        </span>
      ),
      className: 'w-[140px]',
    },
  ];

  return (
    <>
      <PageHeader
        title="Операции"
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" />
            Добавить
          </Button>
        }
      />

      <div className="px-6 py-4">
        <KpiRow loading={summary.isLoading || !summary.data}>
          <KpiCard label="Доходы" value={<Money value={summary.data?.income ?? '0'} tone="plain" />} tone="positive" />
          <KpiCard label="Расходы" value={<Money value={summary.data?.expense ?? '0'} tone="plain" />} tone="negative" />
          <KpiCard label="Чистый денежный поток" value={<Money value={summary.data?.net ?? '0'} />} />
        </KpiRow>
      </div>

      <TransactionFilters
          searchRef={searchRef}
        active={filters}
        onChange={setFilters}
        accounts={accounts.data ?? []}
        categories={allCats}
        counterparties={counterparties.data ?? []}
      />

      <div className="rounded-none border-t border-border bg-card">
        <DataTable
          data={txRows}
          columns={columns}
          rowKey={(t) => t.id}
          groupBy={(t) => formatDayLabel(t.date)}
          renderGroupHeader={(key, rows) => (
            <span className="flex items-center justify-between">
              <span>{key}</span>
              <Money value={sumSigned(rows)} />
            </span>
          )}
          footer={{
            description: 'Итого по видимым',
            // Σ по загруженным страницам infinite-пагинации — «по видимым» и есть.
            amount: <Money value={sumSigned(txRows)} />,
          }}
          onRowClick={(t) => {
            // C1: доменные строки (ноги перевода/комиссия, оплаты заказа) через
            // этот экран не правятся — направляем в их раздел вместо 400 на сохранении.
            if (!t.editable) {
              // Операция заказа — ведём прямо в его карточку (?open= разбирает
              // /orders на маунте): раньше здесь был тупик, строка видна, а
              // исправить её было неоткуда.
              if (t.orderId) {
                router.push(`/orders?order=${t.orderId}` as Parameters<typeof router.push>[0]);
                return;
              }
              toast.info(
                t.transferGroupId
                  ? 'Операция перевода — редактируется в разделе «Переводы»'
                  : 'Автоматическая операция — редактируется в разделе «Заказы», «Закупки» или «Склад»',
              );
              return;
            }
            setEditingId(t.id);
          }}
          loading={txs.isLoading}
          error={txs.error}
          onRetry={() => txs.refetch()}
          empty={
            filters.search ? (
              <EmptyState
                icon={ReceiptText}
                title={`Ничего не найдено по запросу «${filters.search}»`}
                hint={
                  outsideCount
                    ? `За другие даты нашлось: ${outsideCount}.`
                    : 'Проверьте слово или сумму — или сбросьте поиск.'
                }
                action={
                  outsideCount ? (
                    <Button variant="secondary" onClick={showAllDates}>
                      Показать за все даты
                    </Button>
                  ) : (
                    <Button
                      variant="secondary"
                      onClick={() => setFiltersInUrl({ ...filters, search: undefined })}
                    >
                      Сбросить поиск
                    </Button>
                  )
                }
              />
            ) : (
              <EmptyState
                icon={ReceiptText}
                title="За этот период нет операций"
                hint="Добавьте первую операцию через кнопку «Добавить» выше."
                action={
                  <Button onClick={() => setCreating(true)}>
                    <Plus className="h-4 w-4" />
                    Добавить операцию
                  </Button>
                }
              />
            )
          }
          mobileCards={(t) => {
            const cp = t.counterpartyId ? counterpartyById[t.counterpartyId] : undefined;
            const cat = t.categoryId ? categoryById[t.categoryId] : undefined;
            return (
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {t.description?.trim() || cp?.name || cat?.name || (t.type === 'INCOME' ? 'Доход' : 'Расход')}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {formatDate(t.date)} · {accountById[t.accountId]?.name ?? '—'}
                    {cat && ` · ${cat.name}`}
                  </div>
                </div>
                <div
                  className={cn(
                    'shrink-0 text-sm font-semibold tabular-nums',
                    t.type === 'INCOME' ? 'text-success' : 'text-destructive',
                  )}
                >
                  {t.type === 'INCOME' ? '+' : '−'}
                  <Money value={t.amount} tone="plain" />
                </div>
              </div>
            );
          }}
        />
        <LoadMore hasMore={txs.hasNextPage} loading={txs.isFetchingNextPage} onClick={() => void txs.fetchNextPage()} />
        {filters.search && outsideCount && txRows.length > 0 ? (
          <div className="flex flex-wrap items-center justify-center gap-x-2 border-t border-border px-6 py-3 text-sm text-muted-foreground">
            <span>Ещё за другие даты: {outsideCount}</span>
            <Button variant="link" size="sm" onClick={showAllDates}>
              показать
            </Button>
          </div>
        ) : null}
      </div>

      <TransactionFormDialog
        wsId={current.id}
        open={creating || editingId !== null}
        transactionId={editingId}
        onClose={closeForm}
      />
    </>
  );
}
