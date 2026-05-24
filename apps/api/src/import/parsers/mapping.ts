import type { ColumnMapping } from './types';

const PATTERNS = {
  date: /дата|date|проводк/i,
  amount: /сумм|amount|приход|расход|debit|credit/i,
  type: /^тип$|направлен|оборот|operation\s*type/i,
  description: /описан|назначен|комментар|description|memo|operation|категор|details/i,
  counterparty: /контрагент|получател|плательщик|payee|counterparty|merchant|организац|magazin|магазин/i,
};

export function suggestMapping(headers: string[]): Partial<ColumnMapping> {
  const result: Partial<ColumnMapping> = {};
  for (const h of headers) {
    if (!result.date && PATTERNS.date.test(h)) {
      result.date = h;
      continue;
    }
    if (!result.amount && PATTERNS.amount.test(h)) {
      result.amount = h;
      continue;
    }
    if (!result.type && PATTERNS.type.test(h)) {
      result.type = h;
      continue;
    }
    if (!result.counterparty && PATTERNS.counterparty.test(h)) {
      result.counterparty = h;
      continue;
    }
    if (!result.description && PATTERNS.description.test(h)) {
      result.description = h;
      continue;
    }
  }
  return result;
}
