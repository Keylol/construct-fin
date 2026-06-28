import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseAmount, parseDate, detectType } from './values';
import { suggestMapping } from './mapping';
import { detectSourceByFilename } from './detector';
import { parseGenericCsv } from './generic-csv';
import { parseGenericXlsx } from './generic-xlsx';
import { parseAlfaXlsx } from './alfa-xlsx';
import { parseWbPdf } from './wb-pdf';

const FIXTURES = resolve(__dirname, '../../../../../fixtures/imports');

describe('parseAmount', () => {
  it('parses russian formatted amount', () => {
    expect(parseAmount('1 234,56')).toBe('1234.56');
    expect(parseAmount('1 234,56')).toBe('1234.56');
  });
  it('parses english formatted amount', () => {
    expect(parseAmount('1,234.56')).toBe('1234.56');
  });
  it('handles negative and currency suffix', () => {
    expect(parseAmount('-21,540.00 ₽')).toBe('-21540.00');
    expect(parseAmount('500 р')).toBe('500.00');
  });
  it('returns null for garbage', () => {
    expect(parseAmount('hello')).toBeNull();
    expect(parseAmount('')).toBeNull();
    expect(parseAmount(null)).toBeNull();
  });

  // R4a: точность через Decimal, без IEEE754 float
  it('keeps precision for large values (no float drift)', () => {
    expect(parseAmount('99999999.99')).toBe('99999999.99');
    expect(parseAmount('9999999999999.99')).toBe('9999999999999.99');
  });
  it('rounds half-up, not banker / float-toFixed', () => {
    // Number('1.005') === 1.00499999... → toFixed даёт "1.00"; Decimal half-up → "1.01"
    expect(parseAmount('1.005')).toBe('1.01');
    expect(parseAmount('2.675')).toBe('2.68');
    expect(parseAmount('0.005')).toBe('0.01');
  });

  // R4b: эвристика разделителей (запятая-тысячи vs десятичная)
  it('treats comma+exactly-3-digits as thousands, not decimal (1000x bug)', () => {
    expect(parseAmount('1,234')).toBe('1234.00'); // главный баг: было 1.23
    expect(parseAmount('12,345')).toBe('12345.00');
    expect(parseAmount('1,234,567')).toBe('1234567.00');
  });
  it('handles all separator formats unambiguously', () => {
    expect(parseAmount('1,234.56')).toBe('1234.56'); // US
    expect(parseAmount('1.234,56')).toBe('1234.56'); // EU
    expect(parseAmount('1234,56')).toBe('1234.56'); // EU decimal
    expect(parseAmount('1234.56')).toBe('1234.56'); // plain
    expect(parseAmount('1.234.567,89')).toBe('1234567.89'); // EU full
    expect(parseAmount('1,234,567.89')).toBe('1234567.89'); // US full
  });
  it('keeps comma as decimal when not a 3-digit thousands group', () => {
    expect(parseAmount('1,2')).toBe('1.20');
    expect(parseAmount('1,23')).toBe('1.23');
    expect(parseAmount('0,123')).toBe('0.12'); // ведущий ноль → десятичная
    expect(parseAmount('1234,567')).toBe('1234.57'); // 4 цифры до → десятичная
  });
  it('respects explicit decimalSep override', () => {
    expect(parseAmount('1,234', ',')).toBe('1.23'); // явно: запятая десятичная
    expect(parseAmount('1.234', '.')).toBe('1.23'); // явно: точка десятичная
    expect(parseAmount('1.234', ',')).toBe('1234.00'); // явно: точка тысячи
  });
});

describe('parseDate', () => {
  it('parses ISO', () => {
    const d = parseDate('2026-05-17');
    expect(d?.toISOString().slice(0, 10)).toBe('2026-05-17');
  });
  it('parses dd.MM.yyyy', () => {
    const d = parseDate('17.05.2026');
    expect(d?.toISOString().slice(0, 10)).toBe('2026-05-17');
  });
  it('parses dd.MM.yyyy HH:mm', () => {
    const d = parseDate('17.05.2026 16:09');
    expect(d?.toISOString().slice(0, 16)).toBe('2026-05-17T16:09');
  });
  it('returns null for garbage', () => {
    expect(parseDate('not-a-date')).toBeNull();
  });
});

describe('detectType', () => {
  it('detects from raw type word', () => {
    expect(detectType('Расход', null)).toBe('EXPENSE');
    expect(detectType('Приход', null)).toBe('INCOME');
  });
  it('falls back to sign', () => {
    expect(detectType(null, '-100.00')).toBe('EXPENSE');
    expect(detectType(null, '100.00')).toBe('INCOME');
  });
});

describe('suggestMapping', () => {
  it('matches russian headers', () => {
    const m = suggestMapping(['Дата операции', 'Сумма', 'Контрагент', 'Назначение платежа']);
    expect(m.date).toBe('Дата операции');
    expect(m.amount).toBe('Сумма');
    expect(m.counterparty).toBe('Контрагент');
    expect(m.description).toBe('Назначение платежа');
  });
});

describe('detectSourceByFilename', () => {
  it('detects alfa xlsx', () => {
    expect(detectSourceByFilename('Выписка_alfa_2026.xlsx')).toBe('ALFA_XLSX');
    expect(detectSourceByFilename('альфа.xlsx')).toBe('ALFA_XLSX');
  });
  it('detects wb pdf', () => {
    expect(detectSourceByFilename('выписка вб.pdf')).toBe('WB_PDF');
    expect(detectSourceByFilename('wb-statement.pdf')).toBe('WB_PDF');
  });
  it('falls back to generic', () => {
    expect(detectSourceByFilename('random.csv')).toBe('GENERIC_CSV');
    expect(detectSourceByFilename('budget.xlsx')).toBe('GENERIC_XLSX');
  });
});

describe('parseGenericCsv', () => {
  it('parses utf-8 csv with russian headers', () => {
    const csv = 'Дата;Сумма;Контрагент;Назначение\n01.05.2026;1 234,56;ООО Тест;Тестовый платеж\n02.05.2026;-500,00;Магнит;Покупки\n';
    const res = parseGenericCsv(Buffer.from(csv, 'utf-8'));
    expect(res.rows).toHaveLength(2);
    expect(res.rows[0]?.amount).toBe('1234.56');
    expect(res.rows[0]?.type).toBe('INCOME');
    expect(res.rows[1]?.amount).toBe('500.00');
    expect(res.rows[1]?.type).toBe('EXPENSE');
    expect(res.rows[0]?.counterpartyName).toBe('ООО Тест');
  });
  it('auto-detects cp1251', async () => {
    const iconv = await import('iconv-lite');
    const csv = 'Дата;Сумма;Контрагент\n01.05.2026;1000,00;ООО Тест\n';
    const buf = iconv.default.encode(csv, 'win1251');
    const res = parseGenericCsv(buf);
    expect(res.encoding.toLowerCase()).toMatch(/1251|win/);
    expect(res.rows[0]?.counterpartyName).toBe('ООО Тест');
  });
});

describe('parseGenericXlsx', () => {
  it('parses alfa fixture as generic xlsx (suggestedMapping fallback)', async () => {
    const buf = readFileSync(resolve(FIXTURES, 'alfa-sample.xlsx'));
    const res = await parseGenericXlsx(buf);
    expect(res.rows.length).toBeGreaterThan(0);
    expect(res.headers).toContain('Дата');
  });
});

describe('parseAlfaXlsx', () => {
  it('parses real Alfa fixture', async () => {
    const buf = readFileSync(resolve(FIXTURES, 'alfa-sample.xlsx'));
    const res = await parseAlfaXlsx(buf);
    expect(res.source).toBe('ALFA_XLSX');
    expect(res.rows.length).toBeGreaterThan(0);
    for (const row of res.rows) {
      expect(row.date).not.toBeNull();
      expect(row.amount).not.toBeNull();
      expect(row.type).toMatch(/INCOME|EXPENSE/);
      expect(row.errors).toHaveLength(0);
    }
  });
});

describe('parseWbPdf', () => {
  it('parses real WB fixture', async () => {
    const buf = readFileSync(resolve(FIXTURES, 'wb-sample.pdf'));
    const res = await parseWbPdf(buf);
    expect(res.source).toBe('WB_PDF');
    expect(res.rows.length).toBeGreaterThan(0);
    for (const row of res.rows) {
      expect(row.date).not.toBeNull();
      expect(row.amount).not.toBeNull();
      expect(row.type).toMatch(/INCOME|EXPENSE/);
    }
    const hasIncome = res.rows.some((r) => r.type === 'INCOME');
    const hasExpense = res.rows.some((r) => r.type === 'EXPENSE');
    expect(hasIncome).toBe(true);
    expect(hasExpense).toBe(true);
  });
});
