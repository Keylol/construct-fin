import { formatCell, type ReportTable } from './report-table';

const BOM = '﻿';

function escapeCsv(value: string): string {
  if (value === '') return '';
  if (/[",\n;]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function renderCsv(table: ReportTable): Buffer {
  const lines: string[] = [];
  lines.push(escapeCsv(table.title));
  if (table.subtitle) lines.push(escapeCsv(table.subtitle));
  if (table.period) {
    lines.push(escapeCsv(`Период: ${table.period.from.slice(0, 10)} — ${table.period.to.slice(0, 10)}`));
  }
  lines.push('');
  lines.push(table.columns.map((c) => escapeCsv(c.label)).join(','));
  for (const row of table.rows) {
    lines.push(
      table.columns
        .map((c) => escapeCsv(formatCell(row[c.key] ?? null, c.kind)))
        .join(','),
    );
  }
  if (table.totals) {
    lines.push(
      table.columns
        .map((c, idx) => {
          if (idx === 0) return escapeCsv('Итого');
          return escapeCsv(formatCell(table.totals![c.key] ?? null, c.kind));
        })
        .join(','),
    );
  }
  return Buffer.from(BOM + lines.join('\r\n'), 'utf-8');
}
