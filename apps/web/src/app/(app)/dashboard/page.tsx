'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { ArrowRight, ReceiptText, Wallet } from '@/components/ui/icons';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useTransactions, useTransactionSummary } from '@/hooks/useTransactions';
import { useAccounts } from '@/hooks/useAccounts';
import { useCategories } from '@/hooks/useCategories';
import { useCounterparties } from '@/hooks/useCounterparties';
import { PageHeader } from '@/components/ui/PageHeader';
import { KpiCard } from '@/components/ui/KpiCard';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { Button } from '@/components/ui/Button';
import { TransactionListItem } from '@/components/transactions/TransactionListItem';
import { rangeFor } from '@/lib/periods';
import { formatRub } from '@construct/shared';

export default function DashboardPage() {
  const { current } = useCurrentWorkspace();
  const wsId = current?.id ?? null;
  const range = useMemo(() => rangeFor('month'), []);
  const summary = useTransactionSummary(wsId, range);
  const recent = useTransactions(wsId, { ...range, limit: 5 });
  const accounts = useAccounts(wsId);
  const incomeCats = useCategories(wsId, 'INCOME');
  const expenseCats = useCategories(wsId, 'EXPENSE');
  const counterparties = useCounterparties(wsId);

  const allCats = [...(incomeCats.data ?? []), ...(expenseCats.data ?? [])];
  const accountById = Object.fromEntries((accounts.data ?? []).map((a) => [a.id, a]));
  const categoryById = Object.fromEntries(allCats.map((c) => [c.id, c]));
  const counterpartyById = Object.fromEntries(
    (counterparties.data ?? []).map((c) => [c.id, c]),
  );

  if (!current) {
    return (
      <>
        <PageHeader title="Главная" />
        <div className="p-6">
          <EmptyState
            icon={Wallet}
            title="Нет активного пространства"
            hint="Создайте первое пространство через переключатель в меню."
          />
        </div>
      </>
    );
  }

  const isLoading = summary.isLoading;

  return (
    <>
      <PageHeader title="Главная" description="Сводка за текущий месяц" />

      <div className="space-y-6 px-6 py-6">
        <div className="stagger grid gap-4 sm:grid-cols-3">
          {isLoading || !summary.data ? (
            <>
              <Skeleton className="h-[92px]" />
              <Skeleton className="h-[92px]" />
              <Skeleton className="h-[92px]" />
            </>
          ) : (
            <>
              <KpiCard
                label="Доходы"
                value={formatRub(summary.data.income)}
                tone="positive"
              />
              <KpiCard
                label="Расходы"
                value={formatRub(summary.data.expense)}
                tone="negative"
              />
              <KpiCard label="Чистый денежный поток" value={formatRub(summary.data.net)} />
            </>
          )}
        </div>

        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold tracking-tight">Последние операции</h2>
            <Button variant="link" asChild>
              <Link href="/transactions">
                Все
                <ArrowRight className="ml-1 h-3.5 w-3.5" />
              </Link>
            </Button>
          </div>

          {recent.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : recent.data && recent.data.items.length === 0 ? (
            <div className="rounded-lg border border-border bg-card">
              <EmptyState
                icon={ReceiptText}
                title="Пока операций нет"
                hint="Перейдите в раздел «Операции» и добавьте первую."
                action={
                  <Button asChild>
                    <Link href="/transactions">Перейти к операциям</Link>
                  </Button>
                }
              />
            </div>
          ) : (
            <div className="overflow-hidden rounded-lg border border-border bg-card divide-y divide-border">
              {(recent.data?.items ?? []).map((tx) => (
                <TransactionListItem
                  key={tx.id}
                  tx={tx}
                  account={tx.accountId ? accountById[tx.accountId] : undefined}
                  category={tx.categoryId ? categoryById[tx.categoryId] : undefined}
                  counterparty={
                    tx.counterpartyId ? counterpartyById[tx.counterpartyId] : undefined
                  }
                  onClick={() => {
                    window.location.href = '/transactions';
                  }}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  );
}
