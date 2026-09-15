import { createHash } from 'node:crypto';

/** Содержимое операции, по которому считается отпечаток. */
export interface RowHashInput {
  workspaceId: string;
  accountId: string;
  date: Date;
  amount: string;
  type: 'INCOME' | 'EXPENSE';
  counterpartyName: string | null;
  description: string | null;
}

/**
 * Отпечаток операции «как она приехала» — вторая линия дедупа рядом с
 * идентификатором банка.
 *
 * Идентификатор (`externalId`) надёжнее, но существует только внутри одного
 * подключения: выгрузка того же периода в CSV и синк по API приносят одну и ту
 * же операцию с разными ключами. Отпечаток их роднит, потому что считается по
 * содержимому: счёт, дата (до дня), сумма, направление, контрагент и начало
 * назначения.
 *
 * Дата — до дня, текст — в нижнем регистре и обрезан: банк меняет регистр и
 * дописывает хвосты, а операция от этого другой не становится.
 *
 * `occurrence` — номер повтора, когда одинаковых операций несколько (строки-
 * близнецы банка, см. `integrations/bank-line-hash.ts`). У первой номера в
 * отпечатке нет, поэтому отпечатки, уже лежащие в базе, не меняются.
 */
export function computeRowHash(input: RowHashInput & { occurrence?: number }): string {
  const parts = [
    input.workspaceId,
    input.accountId,
    input.date.toISOString().slice(0, 10),
    input.amount,
    input.type,
    (input.counterpartyName ?? '').trim().toLowerCase(),
    (input.description ?? '').trim().toLowerCase().slice(0, 80),
  ];
  if (input.occurrence !== undefined && input.occurrence > 1) parts.push(`#${input.occurrence}`);
  return createHash('sha256').update(parts.join('|')).digest('hex');
}
