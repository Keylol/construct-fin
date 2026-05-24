import type { ImportSource } from '@construct/db';

const NAME_PATTERNS: Array<{ rx: RegExp; source: ImportSource }> = [
  { rx: /alfa|альфа/i, source: 'ALFA_XLSX' },
  { rx: /tinkoff|тинькофф|т-банк|t-bank/i, source: 'TINKOFF_PDF' },
  { rx: /wb|wildberries|вб|выписка вб/i, source: 'WB_PDF' },
];

export function detectSourceByFilename(filename: string, mimeType?: string): ImportSource {
  const isXlsx = /\.xlsx$/i.test(filename) || mimeType?.includes('spreadsheet');
  const isPdf = /\.pdf$/i.test(filename) || mimeType === 'application/pdf';
  const isCsv = /\.csv$/i.test(filename) || mimeType === 'text/csv';

  for (const { rx, source } of NAME_PATTERNS) {
    if (rx.test(filename)) {
      if (source === 'ALFA_XLSX' && isXlsx) return 'ALFA_XLSX';
      if (source === 'TINKOFF_PDF' && isPdf) return 'TINKOFF_PDF';
      if (source === 'WB_PDF' && isPdf) return 'WB_PDF';
    }
  }

  if (isXlsx) return 'GENERIC_XLSX';
  if (isPdf) return 'WB_PDF';
  if (isCsv) return 'GENERIC_CSV';
  return 'GENERIC_CSV';
}
