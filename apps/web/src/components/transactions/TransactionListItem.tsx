'use client';

import type { Transaction, Account, Category, Counterparty } from '@/lib/types';
import { formatRub } from '@construct/shared';
import { cn } from '@/lib/cn';

export function TransactionListItem({
  tx,
  account,
  category,
  counterparty,
  onClick,
}: {
  tx: Transaction;
  account?: Account;
  category?: Category;
  counterparty?: Counterparty;
  onClick: () => void;
}) {
  const dateParts = new Date(tx.date).toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: 'short',
  });
  const [day, month] = dateParts.split(' ');
  const isIncome = tx.type === 'INCOME';

  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-secondary"
    >
      <div className="w-10 shrink-0 text-center">
        <div className="text-[10px] uppercase text-muted-foreground">{month}</div>
        <div className="text-base font-medium tabular-nums">{day}</div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">
          {category?.name ?? (isIncome ? 'Доход' : 'Расход')}
          {counterparty && (
            <span className="font-normal text-muted-foreground"> · {counterparty.name}</span>
          )}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {account?.name ?? '—'}
          {tx.description && ` · ${tx.description}`}
        </div>
      </div>
      <div
        className={cn(
          'shrink-0 text-sm font-semibold tabular-nums',
          isIncome ? 'text-success' : 'text-destructive',
        )}
      >
        {isIncome ? '+' : '−'}
        {formatRub(tx.amount, 2)}
      </div>
    </button>
  );
}
