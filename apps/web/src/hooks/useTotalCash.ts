'use client';

import { useMemo } from 'react';
import { useAccounts, useAccountBalances } from '@/hooks/useAccounts';
import { D, add, toMoneyString } from '@construct/shared';

/**
 * «Всего денег» — единый источник для кассы в хедере и главной цифры дашборда.
 *
 * Главное число — по банку там, где банк его отдаёт, иначе по учёту: остаток
 * по учёту врёт, пока очередь «Входящих» непуста (приходы ещё не проведены,
 * расходы уже проведены правилами), а банку всё равно, разобраны строки или
 * нет. Рядом — сколько строк ждёт разбора и на какую сумму: минус превращается
 * из ошибки учёта в задачу.
 */
export function useTotalCash(wsId: string | null) {
  const accounts = useAccounts(wsId);
  const balances = useAccountBalances(wsId);

  const totals = useMemo(() => {
    if (!accounts.data || !balances.data) return null;
    let total = D(0);
    let ledger = D(0);
    let unresolvedNet = D(0);
    let unresolvedCount = 0;
    let withBank = 0;
    for (const a of accounts.data) {
      if (a.isArchived) continue;
      const b = balances.data.get(a.id);
      if (!b) continue;
      ledger = add(ledger, D(b.ledger));
      total = add(total, D(b.bank ?? b.ledger));
      unresolvedNet = add(unresolvedNet, D(b.unresolvedNet));
      unresolvedCount += b.unresolvedCount;
      if (b.bank != null) withBank++;
    }
    return {
      total: toMoneyString(total),
      ledger: toMoneyString(ledger),
      unresolvedNet: toMoneyString(unresolvedNet),
      unresolvedCount,
      /** Есть ли хоть один счёт с остатком от банка — иначе «по банку» нечего показывать. */
      hasBank: withBank > 0,
    };
  }, [accounts.data, balances.data]);

  return {
    total: totals?.total ?? null,
    ledger: totals?.ledger ?? null,
    unresolvedNet: totals?.unresolvedNet ?? null,
    unresolvedCount: totals?.unresolvedCount ?? 0,
    hasBank: totals?.hasBank ?? false,
    isLoading: accounts.isLoading || balances.isLoading,
  };
}
