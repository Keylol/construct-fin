import ExcelJS from 'exceljs';
import { parseAmount, parseDate } from './values';
import type { ParseResult, ParsedRow } from './types';

const COL_DATE = 1;
const COL_DOC_NO = 2;
const COL_DEBIT = 3;
const COL_CREDIT = 4;
const COL_COUNTERPARTY = 5;
const COL_PURPOSE = 11;

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const obj = value as unknown as Record<string, unknown>;
    if ('richText' in obj && Array.isArray(obj.richText)) {
      return (obj.richText as Array<{ text: string }>).map((rt) => rt.text).join('');
    }
    if ('result' in obj) {
      return cellText(obj.result as ExcelJS.CellValue);
    }
    if ('text' in obj && typeof obj.text === 'string') {
      return obj.text;
    }
  }
  return String(value);
}

function isDateString(s: string): boolean {
  return /^\d{1,2}[.\/\-]\d{1,2}[.\/\-]\d{2,4}/.test(s.trim());
}

export async function parseAlfaXlsx(buffer: Buffer): Promise<ParseResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = wb.worksheets[0];
  if (!sheet) {
    return { headers: [], rows: [], suggestedMapping: {}, encoding: 'utf-8', source: 'ALFA_XLSX' };
  }

  const rows: ParsedRow[] = [];

  for (let i = 1; i <= sheet.rowCount; i++) {
    const row = sheet.getRow(i);
    const dateText = cellText(row.getCell(COL_DATE).value).trim();
    if (!isDateString(dateText)) continue;

    const date = parseDate(dateText);
    if (!date) continue;

    const debitText = cellText(row.getCell(COL_DEBIT).value).trim();
    const creditText = cellText(row.getCell(COL_CREDIT).value).trim();
    const debit = parseAmount(debitText);
    const credit = parseAmount(creditText);

    let amount: string | null = null;
    let type: 'INCOME' | 'EXPENSE' | null = null;
    if (credit && Number(credit) > 0) {
      amount = credit;
      type = 'INCOME';
    } else if (debit && Number(debit) > 0) {
      amount = debit;
      type = 'EXPENSE';
    }

    const errors: string[] = [];
    if (!amount) errors.push(`amount: debit="${debitText}" credit="${creditText}"`);

    const counterparty = cellText(row.getCell(COL_COUNTERPARTY).value).trim() || null;
    const description = cellText(row.getCell(COL_PURPOSE).value).trim() || null;
    const docNo = cellText(row.getCell(COL_DOC_NO).value).trim();

    rows.push({
      rawIndex: rows.length + 1,
      date,
      amount,
      type,
      description,
      counterpartyName: counterparty,
      raw: { date: dateText, docNo, debit: debitText, credit: creditText, counterparty: counterparty ?? '', description: description ?? '' },
      errors,
    });
  }

  return {
    headers: ['Дата', 'Номер документа', 'Дебет', 'Кредит', 'Контрагент', 'Назначение платежа'],
    rows,
    suggestedMapping: {
      date: 'Дата',
      amount: 'Дебет/Кредит',
      counterparty: 'Контрагент',
      description: 'Назначение платежа',
    },
    encoding: 'utf-8',
    source: 'ALFA_XLSX',
  };
}
