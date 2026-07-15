import type { AusnMark, TransactionKind, TxType } from '@prisma/client';

/**
 * Классификация операции для базы АУСН «Доходы−Расходы» (кассовый метод).
 *  INCOME_PLUS   — доход (в базу дохода со знаком +)
 *  INCOME_MINUS  — возврат клиенту (минус из дохода)
 *  EXPENSE_PLUS  — расход (в базу расхода со знаком +)
 *  EXPENSE_MINUS — возврат от поставщика (минус из расхода)
 *  NOT_COUNTED   — вне базы (переводы, капитал, неденежное, сам налог)
 */
export type AusnClass =
  | 'INCOME_PLUS'
  | 'INCOME_MINUS'
  | 'EXPENSE_PLUS'
  | 'EXPENSE_MINUS'
  | 'NOT_COUNTED';

/**
 * Приоритет источника: ручная маркировка/маркировка банка (ausnMark) авторитетна
 * — трактуется как «плюс» в своей корзине. При null — авто по kind/type.
 *
 * Кассовый метод АУСН: доход = поступившие деньги-выручка; расход = уплаченные
 * деньги по деловым основаниям. НЕДЕНЕЖНЫЕ движения (COGS, WRITE_OFF), переводы
 * между своими счетами, вложения/изъятия собственника и САМ налог в базу не идут.
 * Возвраты нетто: возврат клиенту уменьшает доход, возврат поставщика — расход.
 */
export function classifyAusn(tx: {
  type: TxType;
  kind: TransactionKind;
  ausnMark: AusnMark | null;
}): AusnClass {
  if (tx.ausnMark === 'INCOME') return 'INCOME_PLUS';
  if (tx.ausnMark === 'EXPENSE') return 'EXPENSE_PLUS';
  if (tx.ausnMark === 'NOT_COUNTED') return 'NOT_COUNTED';

  switch (tx.kind) {
    // ── Доход ──
    case 'ORDER_PAYMENT':
      return 'INCOME_PLUS';
    case 'ORDER_REFUND':
      return 'INCOME_MINUS'; // возврат клиенту — минус выручка

    // ── Расход ──
    case 'PURCHASE':
    case 'SALARY':
    case 'FIXED_COST':
    case 'VARIABLE_COST':
      return 'EXPENSE_PLUS';
    case 'SUPPLIER_REFUND':
      return 'EXPENSE_MINUS'; // возврат от поставщика — минус расход

    // ── Вне базы ──
    case 'COGS': // неденежная себестоимость (деньги ушли в PURCHASE)
    case 'WRITE_OFF': // неденежное списание
    case 'TRANSFER_IN':
    case 'TRANSFER_OUT':
    case 'CAPITAL_IN':
    case 'CAPITAL_OUT':
    case 'TAX': // сам налог/взносы в базу АУСН не вычитаются
      return 'NOT_COUNTED';

    // ── NON_OP / OTHER — по знаку операции (деловой доход/расход) ──
    case 'NON_OP':
    case 'OTHER':
      return tx.type === 'INCOME' ? 'INCOME_PLUS' : 'EXPENSE_PLUS';
  }
}

/** Ставка налога и минимального налога АУСН «Д−Р». */
export const AUSN_RATE = 0.2; // 20% с (доходы − расходы)
export const AUSN_MIN_RATE = 0.03; // минимальный налог 3% с доходов
