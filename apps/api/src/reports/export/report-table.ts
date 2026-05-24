export type ColumnKind = 'text' | 'money' | 'number' | 'date' | 'percent';

export interface ReportColumn {
  key: string;
  label: string;
  kind: ColumnKind;
  width?: number; // pdf points / excel width
}

export interface ReportTable {
  title: string;
  subtitle?: string;
  period?: { from: string; to: string };
  columns: ReportColumn[];
  rows: Record<string, string | number | null>[];
  totals?: Record<string, string | number | null>;
}

const moneyFormatter = new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const dateFormatter = new Intl.DateTimeFormat('ru-RU', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function formatCell(value: string | number | null | undefined, kind: ColumnKind): string {
  if (value === null || value === undefined || value === '') return '';
  if (kind === 'money') {
    return moneyFormatter.format(Number(value));
  }
  if (kind === 'number') {
    return String(value);
  }
  if (kind === 'percent') {
    return `${(Number(value) * 100).toFixed(1)}%`;
  }
  if (kind === 'date') {
    return dateFormatter.format(new Date(String(value)));
  }
  return String(value);
}
