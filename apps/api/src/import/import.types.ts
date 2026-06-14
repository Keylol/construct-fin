import type { ImportSource } from '@construct/db';
import type { ColumnMapping } from './parsers/types';

/**
 * Подсказка «это похоже на перевод между своими счетами» (Полоса D): импортируемая
 * строка матчится с УЖЕ существующей транзакцией на ДРУГОМ своём счёте —
 * противоположный тип, та же сумма, близкая дата. Это лишь suggestion для UI;
 * фактический перевод создаётся отдельным вызовом API переводов (Полоса A).
 */
export type TransferSuggestion = {
  /** Существующая транзакция-кандидат (контр-нога) на другом счёте. */
  matchedTransactionId: string;
  otherAccountId: string;
  otherAccountName: string;
  otherAccountClass: string;
  /** Тип найденной контр-ноги (противоположен типу импортируемой строки). */
  matchedType: 'INCOME' | 'EXPENSE';
  matchedDate: string;
  /** Расхождение дат в днях (>= 0). */
  daysDiff: number;
};

export type PreviewRow = {
  rawIndex: number;
  date: string;
  amount: string;
  type: 'INCOME' | 'EXPENSE';
  description: string | null;
  counterpartyName: string | null;
  resolvedCounterpartyId: string | null;
  suggestedCategoryId: string | null;
  importHash: string;
  isDuplicate: boolean;
  /** Подсказка-перевод (Полоса D); null — пары не найдено. */
  transferSuggestion: TransferSuggestion | null;
  errors: string[];
  raw: Record<string, string>;
};

export type PreviewResult = {
  source: ImportSource;
  headers: string[];
  suggestedMapping: Partial<ColumnMapping>;
  encoding: string;
  filename: string;
  fileHash: string;
  rows: PreviewRow[];
  stats: { total: number; valid: number; duplicates: number; invalid: number };
};

export type CommitResult = {
  batchId: string;
  imported: number;
  skipped: number;
};
