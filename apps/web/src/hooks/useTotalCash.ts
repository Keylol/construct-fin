'use client';

import { useMemo } from 'react';
import { useAccounts, useAccountBalances } from '@/hooks/useAccounts';
import { D, add, toMoneyString } from '@construct/shared';

/**
 * «Всего денег» — сумма текущих остатков активных счетов (Decimal-строка).
 * Единый источник для кассы в хедере и главной цифры дашборда.
 */
export function useTotalCash(wsId: string | null) {
  const accounts = useAccounts(wsId);
  const balances = useAccountBalances(wsId);

  const total = useMemo(() => {
    if (!accounts.data || !balances.data) return null;
    let acc = D(0);
    for (const a of accounts.data) {
      if (a.isArchived) continue;
      const b = balances.data.get(a.id);
      if (b != null) acc = add(acc, D(b));
    }
    return toMoneyString(acc);
  }, [accounts.data, balances.data]);

  return { total, isLoading: accounts.isLoading || balances.isLoading };
}
