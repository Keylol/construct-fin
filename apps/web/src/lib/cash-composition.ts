import { formatRub } from '@construct/shared';
import type { CashBreakdown } from '@/hooks/useTotalCash';

/**
 * Из чего сложилась касса — одной строкой под главной цифрой.
 *
 * Итог собирается из разнородного: расчётный счёт по синку с банком, нал,
 * личные карты и счета-корзины без выписки. Последние сидят в минусе (с них
 * платили, а поступления не заведены) и утаскивают итог вниз — без разбивки
 * выглядит так, будто денег меньше, чем показывает банк. Пустые части не
 * печатаем, а на одной части строка бессмысленна — тогда null.
 */
export function cashCompositionText(breakdown: CashBreakdown | null): string | null {
  if (!breakdown) return null;
  const parts: string[] = [];
  if (Number(breakdown.bank) !== 0) parts.push(`банк ${formatRub(breakdown.bank, 0)}`);
  if (Number(breakdown.cash) !== 0) parts.push(`нал ${formatRub(breakdown.cash, 0)}`);
  if (Number(breakdown.cards) !== 0) parts.push(`карты ${formatRub(breakdown.cards, 0)}`);
  if (Number(breakdown.negative) !== 0) {
    parts.push(`счета без выписки ${formatRub(breakdown.negative, 0)}`);
  }
  return parts.length > 1 ? parts.join(' · ') : null;
}
