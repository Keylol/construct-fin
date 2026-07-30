import { createHash } from 'node:crypto';

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
 */
export function computeRowHash(input: {
  workspaceId: string;
  accountId: string;
  date: Date;
  amount: string;
  type: 'INCOME' | 'EXPENSE';
  counterpartyName: string | null;
  description: string | null;
}): string {
  const canonical = [
    input.workspaceId,
    input.accountId,
    input.date.toISOString().slice(0, 10),
    input.amount,
    input.type,
    (input.counterpartyName ?? '').trim().toLowerCase(),
    (input.description ?? '').trim().toLowerCase().slice(0, 80),
  ].join('|');
  return createHash('sha256').update(canonical).digest('hex');
}
