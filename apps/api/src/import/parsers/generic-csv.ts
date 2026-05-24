import { parse } from 'csv-parse/sync';
import { decodeBuffer } from './encoding';
import { suggestMapping } from './mapping';
import { detectType, parseAmount, parseDate } from './values';
import type { ColumnMapping, ParseResult, ParsedRow } from './types';

const DELIMITERS = [';', '\t', ',', '|'];

function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  let best = ',';
  let bestCount = 0;
  for (const d of DELIMITERS) {
    const count = firstLine.split(d).length - 1;
    if (count > bestCount) {
      bestCount = count;
      best = d;
    }
  }
  return best;
}

export function parseGenericCsv(
  buffer: Buffer,
  mapping?: ColumnMapping,
  encoding?: string,
): ParseResult {
  const { text, encoding: enc } = decodeBuffer(buffer, encoding);
  const delimiter = detectDelimiter(text);

  const records = parse(text, {
    delimiter,
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
    relax_column_count: true,
    bom: true,
    trim: true,
  }) as Record<string, string>[];

  const headers = records.length > 0 ? Object.keys(records[0] ?? {}) : [];
  const suggested = suggestMapping(headers);
  const m: Partial<ColumnMapping> = mapping ?? suggested;

  const rows: ParsedRow[] = records.map((rec, i) => {
    const errors: string[] = [];
    const dateRaw = m.date ? rec[m.date] : '';
    const amountRaw = m.amount ? rec[m.amount] : '';

    const date = parseDate(dateRaw);
    if (!date && m.date) errors.push(`date: "${dateRaw ?? ''}"`);

    const amountSigned = parseAmount(amountRaw, m.amountDecimalSeparator);
    if (!amountSigned && m.amount) errors.push(`amount: "${amountRaw ?? ''}"`);

    const typeRaw = m.type ? rec[m.type] : null;
    const type = detectType(typeRaw, amountSigned);
    const amount = amountSigned ? amountSigned.replace(/^-/, '') : null;

    return {
      rawIndex: i + 1,
      date,
      amount,
      type,
      description: m.description ? (rec[m.description] ?? null) : null,
      counterpartyName: m.counterparty ? (rec[m.counterparty] ?? null) : null,
      raw: rec,
      errors,
    };
  });

  return { headers, rows, suggestedMapping: suggested, encoding: enc, source: 'GENERIC_CSV' };
}
