'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useTransactions, useTransactionSummary } from '@/hooks/useTransactions';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { TransactionListItem } from '@/components/transactions/TransactionListItem';
import { rangeFor } from '@/lib/periods';
import { formatRub } from '@construct/shared';
import { useAccounts } from '@/hooks/useAccounts';
import { useCategories } from '@/hooks/useCategories';
import { useCounterparties } from '@/hooks/useCounterparties';

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
      <EmptyState
        title="Нет активного пространства"
        hint="Создайте первое пространство через переключатель слева."
      />
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Главная</h1>
      <p className="text-xs uppercase tracking-wide text-muted">Текущий месяц</p>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <div className="text-xs uppercase tracking-wide text-muted mb-1">Доход</div>
          <div className="text-2xl font-semibold text-success tabular-nums">
            {summary.data ? formatRub(summary.data.income) : '—'}
          </div>
        </Card>
        <Card>
          <div className="text-xs uppercase tracking-wide text-muted mb-1">Расход</div>
          <div className="text-2xl font-semibold text-danger tabular-nums">
            {summary.data ? formatRub(summary.data.expense) : '—'}
          </div>
        </Card>
        <Card>
          <div className="text-xs uppercase tracking-wide text-muted mb-1">Чистый</div>
          <div className="text-2xl font-semibold tabular-nums">
            {summary.data ? formatRub(summary.data.net) : '—'}
          </div>
        </Card>
      </div>

      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Последние операции</h2>
        <Link href="/transactions" className="text-tint text-sm hover:underline">
          Все →
        </Link>
      </div>

      {recent.data && recent.data.items.length === 0 ? (
        <Card>
          <p className="text-muted text-sm">
            Пока операций нет. Перейдите в раздел «Операции» и добавьте первую.
          </p>
        </Card>
      ) : (
        <Card className="!p-2">
          {(recent.data?.items ?? []).map((tx) => (
            <TransactionListItem
              key={tx.id}
              tx={tx}
              account={tx.accountId ? accountById[tx.accountId] : undefined}
              category={tx.categoryId ? categoryById[tx.categoryId] : undefined}
              counterparty={tx.counterpartyId ? counterpartyById[tx.counterpartyId] : undefined}
              onClick={() => {
                window.location.href = '/transactions';
              }}
            />
          ))}
        </Card>
      )}
    </div>
  );
}
