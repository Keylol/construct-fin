import { formatCell, type ColumnKind, type ReportTable } from './report-table';

const BOM = '﻿';

// Column kinds whose values are produced by formatCell from numbers (or dates)
// and are therefore NOT free user text. A leading '-' here is a numeric sign
// (e.g. "-1234.56") and must be preserved so the file re-imports as a number.
const NUMERIC_KINDS: ReadonlySet<ColumnKind> = new Set(['money', 'number', 'percent', 'date']);

// Characters that make Excel / LibreOffice / Google Sheets treat a cell as a
// formula when they are the FIRST character: = + - @, plus TAB and CR which can
// smuggle a formula start past naive checks.
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/**
 * Neutralize spreadsheet formula injection by prefixing a single quote, which
 * forces Excel/Sheets to render the cell as literal text. Applied to free-text
 * cells only (headers, category/counterparty names) — never to numeric cells,
 * where a leading '-' is a legitimate sign.
 */
export function neutralizeFormula(value: string): string {
  if (value !== '' && FORMULA_PREFIX.test(value)) {
    return `'${value}`;
  }
  return value;
}

/** Standard CSV quoting for delimiters / quotes / newlines. */
export function quoteCsv(value: string): string {
  if (value === '') return '';
  if (/[",\n;]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Free-text field: neutralize formulas first, then CSV-quote. */
function escapeText(value: string): string {
  return quoteCsv(neutralizeFormula(value));
}

/** Row/total field: protect text columns, leave numeric/date columns intact. */
function escapeCell(value: string, kind: ColumnKind): string {
  return NUMERIC_KINDS.has(kind) ? quoteCsv(value) : escapeText(value);
}

export function renderCsv(table: ReportTable): Buffer {
  const lines: string[] = [];
  lines.push(escapeText(table.title));
  if (table.subtitle) lines.push(escapeText(table.subtitle));
  if (table.period) {
    lines.push(escapeText(`Период: ${table.period.from.slice(0, 10)} — ${table.period.to.slice(0, 10)}`));
  }
  lines.push('');
  lines.push(table.columns.map((c) => escapeText(c.label)).join(','));
  for (const row of table.rows) {
    lines.push(
      table.columns
        .map((c) => escapeCell(formatCell(row[c.key] ?? null, c.kind), c.kind))
        .join(','),
    );
  }
  if (table.totals) {
    lines.push(
      table.columns
        .map((c, idx) => {
          if (idx === 0) return escapeText('Итого');
          return escapeCell(formatCell(table.totals![c.key] ?? null, c.kind), c.kind);
        })
        .join(','),
    );
  }
  return Buffer.from(BOM + lines.join('\r\n'), 'utf-8');
}
