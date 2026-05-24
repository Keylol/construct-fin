import ExcelJS from 'exceljs';
import { suggestMapping } from './mapping';
import { detectType, parseAmount, parseDate } from './values';
import type { ColumnMapping, ParseResult, ParsedRow } from './types';

function cellToString(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const obj = value as unknown as Record<string, unknown>;
    if ('richText' in obj && Array.isArray(obj.richText)) {
      return (obj.richText as Array<{ text: string }>).map((rt) => rt.text).join('');
    }
    if ('result' in obj) {
      return cellToString(obj.result as ExcelJS.CellValue);
    }
    if ('text' in obj && typeof obj.text === 'string') {
      return obj.text;
    }
    if ('hyperlink' in obj && typeof obj.hyperlink === 'string') {
      return typeof obj.text === 'string' ? obj.text : obj.hyperlink;
    }
  }
  return String(value);
}

function findHeaderRow(sheet: ExcelJS.Worksheet): number {
  const maxScan = Math.min(sheet.rowCount, 30);
  let bestRow = 1;
  let bestScore = 0;
  for (let i = 1; i <= maxScan; i++) {
    const row = sheet.getRow(i);
    const cells: string[] = [];
    row.eachCell({ includeEmpty: false }, (c) => cells.push(cellToString(c.value).trim()));
    const letterCells = cells.filter((c) => /[A-Za-zА-Яа-я]/.test(c));
    if (letterCells.length < 2) continue;
    const shortPhrases = letterCells.filter((c) => c.length <= 40 && !/[:№]/.test(c));
    const score = shortPhrases.length;
    if (score > bestScore) {
      bestScore = score;
      bestRow = i;
    }
  }
  return bestRow;
}

export async function parseGenericXlsx(
  buffer: Buffer,
  mapping?: ColumnMapping,
  sheetName?: string,
): Promise<ParseResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = sheetName ? wb.getWorksheet(sheetName) : wb.worksheets[0];
  if (!sheet) {
    return { headers: [], rows: [], suggestedMapping: {}, encoding: 'utf-8', source: 'GENERIC_XLSX' };
  }

  const headerRowIdx = findHeaderRow(sheet);
  const headerRow = sheet.getRow(headerRowIdx);
  const headers: string[] = [];
  const headerCols: number[] = [];
  headerRow.eachCell({ includeEmpty: false }, (c, col) => {
    const text = cellToString(c.value).trim();
    if (text) {
      headers.push(text);
      headerCols.push(col);
    }
  });

  const suggested = suggestMapping(headers);
  const m: Partial<ColumnMapping> = mapping ?? suggested;

  const rows: ParsedRow[] = [];
  for (let i = headerRowIdx + 1; i <= sheet.rowCount; i++) {
    const row = sheet.getRow(i);
    const rec: Record<string, string> = {};
    let hasAny = false;
    headerCols.forEach((col, idx) => {
      const key = headers[idx];
      if (!key) return;
      const text = cellToString(row.getCell(col).value);
      rec[key] = text;
      if (text) hasAny = true;
    });
    if (!hasAny) continue;

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

    rows.push({
      rawIndex: rows.length + 1,
      date,
      amount,
      type,
      description: m.description ? (rec[m.description] ?? null) : null,
      counterpartyName: m.counterparty ? (rec[m.counterparty] ?? null) : null,
      raw: rec,
      errors,
    });
  }

  return { headers, rows, suggestedMapping: suggested, encoding: 'utf-8', source: 'GENERIC_XLSX' };
}
