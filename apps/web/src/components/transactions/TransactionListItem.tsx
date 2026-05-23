'use client';

import type { Transaction, Account, Category, Counterparty } from '@/lib/types';
import { formatRub } from '@construct/shared';

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
  const date = new Date(tx.date).toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: 'short',
  });
  const isIncome = tx.type === 'INCOME';

  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left flex items-center gap-3 px-4 py-3 rounded-2xl hover:bg-glass/50 transition"
    >
      <div className="w-10 text-center">
        <div className="text-[10px] text-muted uppercase">{date.split(' ')[1]}</div>
        <div className="text-base font-medium">{date.split(' ')[0]}</div>
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-fg font-medium truncate">
          {category?.name ?? (isIncome ? 'Доход' : 'Расход')}
          {counterparty && <span className="text-muted font-normal"> · {counterparty.name}</span>}
        </div>
        <div className="text-xs text-muted truncate">
          {account?.name ?? '—'}
          {tx.description && ` · ${tx.description}`}
        </div>
      </div>
      <div className={`font-semibold tabular-nums ${isIncome ? 'text-success' : 'text-fg'}`}>
        {isIncome ? '+' : '−'}
        {formatRub(tx.amount, 2)}
      </div>
    </button>
  );
}
