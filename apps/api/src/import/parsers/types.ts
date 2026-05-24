import type { ImportSource } from '@construct/db';

export type ParsedRow = {
  rawIndex: number;
  date: Date | null;
  amount: string | null;
  type: 'INCOME' | 'EXPENSE' | null;
  description: string | null;
  counterpartyName: string | null;
  raw: Record<string, string>;
  errors: string[];
};

export type ColumnMapping = {
  date: string;
  amount: string;
  type?: string;
  description?: string;
  counterparty?: string;
  amountDecimalSeparator?: '.' | ',';
};

export type ParseResult = {
  headers: string[];
  rows: ParsedRow[];
  suggestedMapping: Partial<ColumnMapping>;
  encoding: string;
  source: ImportSource;
};

export type Parser = {
  source: ImportSource;
  parse(buffer: Buffer, mapping?: ColumnMapping): Promise<ParseResult> | ParseResult;
};
