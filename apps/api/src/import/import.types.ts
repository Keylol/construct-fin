import type { ImportSource } from '@construct/db';
import type { ColumnMapping } from './parsers/types';

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

export type RollbackResult = {
  rolledBack: number;
};
