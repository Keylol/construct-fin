'use client';

import { useMemo, useState } from 'react';
import { Plus, ReceiptText, Wallet } from '@/components/ui/icons';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
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
import { rangeFor } from '@/lib/periods';
import { formatRub } from '@construct/shared';
import { cn } from '@/lib/cn';
import type { Transaction } from '@/lib/types';

const DATE_FMT = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

export default function TransactionsPage() {
  const { current } = useCurrentWorkspace();
  const wsId = current?.id ?? null;
  const accounts = useAccounts(wsId);
  const incomeCats = useCategories(wsId, 'INCOME');
  const expenseCats = useCategories(wsId, 'EXPENSE');
  const counterparties = useCounterparties(wsId);

  const [filters, setFilters] = useState<ActiveFilters>({
    period: 'month',
    range: rangeFor('month'),
  });

  const apiFilters: TF = useMemo(
    () => ({
      from: filters.range.from,
      to: filters.range.to,
      accountId: filters.accountId,
      categoryId: filters.categoryId,
      counterpartyId: filters.counterpartyId,
      type: filters.type,
      search: filters.search,
      limit: 100,
    }),
    [filters],
  );

  const txs = useInfiniteTransactions(wsId, apiFilters);
  const summary = useTransactionSummary(wsId, filters.range);

  const txRows = useMemo<Transaction[]>(
    () => txs.data?.pages.flatMap((p) => p.items) ?? [],
    [txs.data],
  );

  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

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

  const columns: Column<Transaction>[] = [
    {
      key: 'date',
      header: 'Дата',
      cell: (t) => (
        <span className="whitespace-nowrap text-muted-foreground tabular-nums">
          {DATE_FMT.format(new Date(t.date))}
        </span>
      ),
      sortable: true,
      className: 'w-[110px]',
    },
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
      sortable: true,
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
        breadcrumbs={[{ label: 'Учёт' }, { label: 'Операции' }]}
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
              <KpiCard label="Доход" value={formatRub(summary.data.income)} tone="positive" />
              <KpiCard label="Расход" value={formatRub(summary.data.expense)} tone="negative" />
              <KpiCard label="Чистый" value={formatRub(summary.data.net)} />
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
          onRowClick={(t) => {
            // C1: доменные строки (ноги перевода/комиссия, оплаты заказа) через
            // этот экран не правятся — направляем в их раздел вместо 400 на сохранении.
            if (!t.editable) {
              toast.info(
                t.transferGroupId
                  ? 'Операция перевода — правится в разделе «Переводы»'
                  : t.orderId
                    ? 'Операция по заказу — правится в карточке заказа'
                    : 'Автоматическая операция — правится в своём разделе',
              );
              return;
            }
            setEditingId(t.id);
          }}
          loading={txs.isLoading}
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
                    {DATE_FMT.format(new Date(t.date))} · {accountById[t.accountId]?.name ?? '—'}
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
        onClose={() => {
          setCreating(false);
          setEditingId(null);
        }}
      />
    </>
  );
}
