'use client';

import { useMemo } from 'react';
import { useAccounts, useAccountBalances } from '@/hooks/useAccounts';
import { D, add, toMoneyString } from '@construct/shared';

/** Из чего сложилась касса: банк, нал, прочие кошельки и счета в минусе. */
export interface CashBreakdown {
  /** Счета, по которым остаток отдаёт сам банк (синк по API). */
  bank: string;
  /** Наличные. */
  cash: string;
  /** Остальные кошельки с плюсом — личные карты, считаются по учёту. */
  cards: string;
  /**
   * Счета без выписки, ушедшие в минус: с них платили, а откуда пришли деньги —
   * не заведено. Это не касса, а незакрытая дыра учёта, поэтому показываем её
   * отдельной строкой, а не растворяем в итоге.
   */
  negative: string;
  negativeCount: number;
}

/**
 * «Всего денег» — единый источник для кассы в хедере, на главной и в «Счетах».
 *
 * Главное число — по банку там, где банк его отдаёт, иначе по учёту: остаток
 * по учёту врёт, пока очередь «Входящих» непуста (приходы ещё не проведены,
 * расходы уже проведены правилами), а банку всё равно, разобраны строки или
 * нет. Рядом — сколько строк ждёт разбора и на какую сумму: минус превращается
 * из ошибки учёта в задачу.
 *
 * Итог складывается из разнородного: расчётный счёт с синком, нал, личные
 * карты и счета-корзины без выписки («ВБ Дерябин», «Иное»). Последние сидят в
 * минусе и утаскивают итог вниз — со стороны выглядит так, будто денег меньше,
 * чем показывает банк. Поэтому рядом с итогом отдаём его состав: видно, что
 * банк и нал на месте, а минус — это работа, а не пропавшие деньги.
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
    // Разнесение непересекающееся: сумма четырёх частей равна итогу.
    let bank = D(0);
    let cash = D(0);
    let cards = D(0);
    let negative = D(0);
    let negativeCount = 0;
    for (const a of accounts.data) {
      if (a.isArchived) continue;
      const b = balances.data.get(a.id);
      if (!b) continue;
      ledger = add(ledger, D(b.ledger));
      const own = D(b.bank ?? b.ledger);
      total = add(total, own);
      unresolvedNet = add(unresolvedNet, D(b.unresolvedNet));
      unresolvedCount += b.unresolvedCount;
      if (b.bank != null) {
        // Минус на счёте с выпиской — настоящий овердрафт, он остаётся в банке.
        withBank++;
        bank = add(bank, own);
      } else if (own.isNegative()) {
        negative = add(negative, own);
        negativeCount++;
      } else if (a.type === 'CASH') {
        cash = add(cash, own);
      } else {
        cards = add(cards, own);
      }
    }
    return {
      total: toMoneyString(total),
      ledger: toMoneyString(ledger),
      unresolvedNet: toMoneyString(unresolvedNet),
      unresolvedCount,
      /** Есть ли хоть один счёт с остатком от банка — иначе «по банку» нечего показывать. */
      hasBank: withBank > 0,
      breakdown: {
        bank: toMoneyString(bank),
        cash: toMoneyString(cash),
        cards: toMoneyString(cards),
        negative: toMoneyString(negative),
        negativeCount,
      } satisfies CashBreakdown,
    };
  }, [accounts.data, balances.data]);

  return {
    total: totals?.total ?? null,
    ledger: totals?.ledger ?? null,
    unresolvedNet: totals?.unresolvedNet ?? null,
    unresolvedCount: totals?.unresolvedCount ?? 0,
    hasBank: totals?.hasBank ?? false,
    breakdown: totals?.breakdown ?? null,
    isLoading: accounts.isLoading || balances.isLoading,
  };
}
