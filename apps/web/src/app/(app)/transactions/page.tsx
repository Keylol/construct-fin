'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Plus, ReceiptText, Wallet } from '@/components/ui/icons';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
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
import { Skeleton } from '@/components/ui/Skeleton';
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
  searchParamsToFilters,
  writeSavedPeriod,
} from '@/lib/tx-filters';
import { D, add, sub, toMoneyString, formatRub } from '@construct/shared';
import { cn } from '@/lib/cn';
import type { Transaction } from '@/lib/types';
import { formatDate, formatDayLabel } from '@/lib/dates';
import { rangeFor } from '@/lib/periods';

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

  // Инициализация из URL (drill-down из отчётов/карточек). Ленивый инициализатор —
  // читаем один раз на маунте; дальше состояние ведёт форма фильтров + router.replace.
  const [filters, setFiltersState] = useState<ActiveFilters>(() =>
    searchParamsToFilters(searchParams),
  );

  // Пишем измерения фильтров обратно в URL (deep-link на текущий разрез).
  // replace, а не push — клики по фильтрам не засоряют историю браузера.
  const setFilters = useCallback(
    (next: ActiveFilters) => {
      // Период запоминаем только когда его выбрал человек: возвращаться в
      // текущий месяц на каждом заходе — лишний клик, а работают неделями в
      // одном периоде. Измерения не помним (см. tx-filters).
      if (next.period !== filters.period) writeSavedPeriod(next.period);
      setFiltersState(next);
      const qs = filtersToSearchParams(next);
      const href = (qs ? `${pathname}?${qs}` : pathname) as Parameters<typeof router.replace>[0];
      router.replace(href, { scroll: false });
    },
    [pathname, router, filters.period],
  );

  /**
   * Сохранённый период применяем после маунта (как useTileView): localStorage
   * на сервере не существует, а читать его в инициализаторе — рассинхрон
   * гидратации. Drill-down с явными from/to главнее: там период задал отчёт.
   */
  useEffect(() => {
    if (searchParams.get('from') || searchParams.get('to')) return;
    const saved = readSavedPeriod();
    if (!saved) return;
    setFiltersState((prev) =>
      prev.period === saved ? prev : { ...prev, period: saved, range: rangeFor(saved) },
    );
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

  const [editingId, setEditingId] = useState<string | null>(null);
  // ?new=1 (из глобального «+ Создать») открывает форму создания сразу на маунте.
  const [creating, setCreating] = useState(() => searchParams.get('new') === '1');

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

  if (!current) {
    return (
      <>
        <PageHeader title="Операции" />
        <div className="p-6">
          <EmptyState
            icon={Wallet}
            title="Нет активного пространства"
            hint="Выберите или создайте пространство."
          />
        </div>
      </>
    );
  }

  // Колонка «Дата» ушла в заголовки дневных групп (№27); в mobileCards дата остаётся.
  const columns: Column<Transaction>[] = [
    {
      key: 'description',
      header: 'Описание',
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
          {formatRub(t.amount, 2)}
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

      <div className="space-y-4 px-6 py-4">
        <div className="grid gap-3 sm:grid-cols-3">
          {summary.isLoading || !summary.data ? (
            <>
              <Skeleton className="h-[88px]" />
              <Skeleton className="h-[88px]" />
              <Skeleton className="h-[88px]" />
            </>
          ) : (
            <>
              <KpiCard label="Доходы" value={formatRub(summary.data.income)} tone="positive" />
              <KpiCard label="Расходы" value={formatRub(summary.data.expense)} tone="negative" />
              <KpiCard label="Чистый денежный поток" value={formatRub(summary.data.net)} />
            </>
          )}
        </div>
      </div>

      <TransactionFilters
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
              <span className="num">{formatRub(sumSigned(rows))}</span>
            </span>
          )}
          footer={{
            description: 'Итого по видимым',
            // Σ по загруженным страницам infinite-пагинации — «по видимым» и есть.
            amount: formatRub(sumSigned(txRows)),
          }}
          onRowClick={(t) => {
            // C1: доменные строки (ноги перевода/комиссия, оплаты заказа) через
            // этот экран не правятся — направляем в их раздел вместо 400 на сохранении.
            if (!t.editable) {
              // Операция заказа — ведём прямо в его карточку (?open= разбирает
              // /orders на маунте): раньше здесь был тупик, строка видна, а
              // исправить её было неоткуда.
              if (t.orderId) {
                router.push(`/orders?open=${t.orderId}` as Parameters<typeof router.push>[0]);
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
                  {formatRub(t.amount, 2)}
                </div>
              </div>
            );
          }}
        />
        {txs.hasNextPage && (
          <div className="flex justify-center border-t border-border py-4">
            <Button
              variant="secondary"
              onClick={() => txs.fetchNextPage()}
              disabled={txs.isFetchingNextPage}
            >
              {txs.isFetchingNextPage ? 'Загрузка…' : 'Загрузить ещё'}
            </Button>
          </div>
        )}
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
