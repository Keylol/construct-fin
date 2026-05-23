'use client';

import { useMemo, useState } from 'react';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useAccounts } from '@/hooks/useAccounts';
import { useCategories } from '@/hooks/useCategories';
import { useCounterparties } from '@/hooks/useCounterparties';
import { useTransactions, type TransactionFilters as TF } from '@/hooks/useTransactions';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { TransactionFilters, type ActiveFilters } from '@/components/transactions/TransactionFilters';
import { TransactionListItem } from '@/components/transactions/TransactionListItem';
import { TransactionFormDialog } from '@/components/transactions/TransactionFormDialog';
import { Fab } from '@/components/transactions/Fab';
import { rangeFor } from '@/lib/periods';

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

  const txs = useTransactions(wsId, apiFilters);

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
    return <EmptyState title="Нет активного пространства" hint="Выберите или создайте пространство." />;
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Операции</h1>

      <TransactionFilters
        active={filters}
        onChange={setFilters}
        accounts={accounts.data ?? []}
        categories={allCats}
        counterparties={counterparties.data ?? []}
      />

      {txs.isLoading && <Card>Загрузка…</Card>}
      {txs.error && <Card className="text-danger">Ошибка: {String(txs.error)}</Card>}

      {txs.data && txs.data.items.length === 0 && (
        <EmptyState
          title="За этот период нет операций"
          hint="Добавьте первую операцию через кнопку + справа внизу."
          action={<Button onClick={() => setCreating(true)}>+ Добавить операцию</Button>}
        />
      )}

      {txs.data && txs.data.items.length > 0 && (
        <Card className="!p-2">
          {txs.data.items.map((tx) => (
            <TransactionListItem
              key={tx.id}
              tx={tx}
              account={tx.accountId ? accountById[tx.accountId] : undefined}
              category={tx.categoryId ? categoryById[tx.categoryId] : undefined}
              counterparty={tx.counterpartyId ? counterpartyById[tx.counterpartyId] : undefined}
              onClick={() => setEditingId(tx.id)}
            />
          ))}
        </Card>
      )}

      <Fab onClick={() => setCreating(true)} />

      <TransactionFormDialog
        wsId={current.id}
        open={creating || editingId !== null}
        transactionId={editingId}
        onClose={() => {
          setCreating(false);
          setEditingId(null);
        }}
      />
    </div>
  );
}
