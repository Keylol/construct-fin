import { describe, expect, it } from 'vitest';
import { neutralizeFormula, quoteCsv, renderCsv } from './csv';
import type { ReportTable } from './report-table';

const BOM = '﻿';

/** Drop BOM and split a rendered CSV into rows (split on the CRLF separator). */
function rows(buf: Buffer): string[] {
  const text = buf.toString('utf-8');
  expect(text.startsWith(BOM)).toBe(true);
  return text.slice(BOM.length).split('\r\n');
}

/**
 * Parse the rendered CSV into structural parts without depending on absolute
 * indices: renderCsv emits title (+optional subtitle/period), then one blank
 * line, then the header row, then data rows (totals, if any, is the last row).
 */
function parse(buf: Buffer): { header: string; data: string[] } {
  const all = rows(buf);
  const blank = all.indexOf('');
  expect(blank).toBeGreaterThanOrEqual(0);
  return { header: all[blank + 1]!, data: all.slice(blank + 2) };
}

describe('neutralizeFormula (unit)', () => {
  it('prefixes a single quote for each formula-trigger leading char', () => {
    expect(neutralizeFormula('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(neutralizeFormula('+79991234567')).toBe("'+79991234567");
    expect(neutralizeFormula('-foo')).toBe("'-foo");
    expect(neutralizeFormula('@cmd')).toBe("'@cmd");
    expect(neutralizeFormula('\tTAB')).toBe("'\tTAB");
    expect(neutralizeFormula('\rCR')).toBe("'\rCR");
  });

  it('leaves ordinary text untouched', () => {
    expect(neutralizeFormula('Ромашка')).toBe('Ромашка');
    expect(neutralizeFormula('ООО "Ромашка"')).toBe('ООО "Ромашка"');
    expect(neutralizeFormula('')).toBe('');
    // dangerous char NOT in leading position → safe
    expect(neutralizeFormula('a=b')).toBe('a=b');
  });
});

describe('renderCsv — formula injection protection', () => {
  it('(1) neutralizes a formula in a text category name', () => {
    const table: ReportTable = {
      title: 'Отчёт',
      columns: [
        { key: 'name', label: 'Категория', kind: 'text' },
        { key: 'sum', label: 'Сумма', kind: 'money' },
      ],
      rows: [{ name: '=SUM(A1)', sum: '100' }],
    };
    const { header, data } = parse(renderCsv(table));
    expect(header).toBe('Категория,Сумма');
    // text cell neutralized -> '=SUM(A1) (no comma inside, so unquoted);
    // money cell "100,00" (ru-RU comma decimal) gets CSV-quoted.
    expect(data[0]).toBe(`'=SUM(A1),"100,00"`);
  });

  it('(2) neutralizes +, -, @, TAB, CR leading chars in text cells', () => {
    const table: ReportTable = {
      title: 'T',
      columns: [{ key: 'name', label: 'Имя', kind: 'text' }],
      rows: [
        { name: '+79991234567' },
        { name: '-foo' },
        { name: '@cmd' },
        { name: '\tTAB' },
        { name: '\rCR' },
      ],
    };
    const { data } = parse(renderCsv(table));
    expect(data[0]).toBe("'+79991234567");
    expect(data[1]).toBe("'-foo");
    expect(data[2]).toBe("'@cmd");
    // \t and \r are not CSV delimiters, so only the formula prefix applies.
    expect(data[3]).toBe("'\tTAB");
    expect(data[4]).toBe("'\rCR");
  });

  it('(3) leaves ordinary text names unchanged', () => {
    const table: ReportTable = {
      title: 'T',
      columns: [{ key: 'name', label: 'Контрагент', kind: 'text' }],
      rows: [{ name: 'Ромашка' }],
    };
    const out = rows(renderCsv(table));
    expect(out[out.length - 1]).toBe('Ромашка');
  });

  it('(4) keeps negative numbers in numeric columns intact (no quote prefix)', () => {
    const table: ReportTable = {
      title: 'T',
      columns: [
        { key: 'name', label: 'Категория', kind: 'text' },
        { key: 'amount', label: 'Сумма', kind: 'money' },
        { key: 'qty', label: 'Кол-во', kind: 'number' },
      ],
      rows: [{ name: 'Возврат', amount: -1234.56, qty: -5 }],
    };
    const out = rows(renderCsv(table));
    const dataRow = out[out.length - 1]!;
    const cells = dataRow.split(',');
    expect(cells[0]).toBe('Возврат');
    // No numeric cell may be prefixed with the formula-escape quote.
    expect(cells.some((c) => c.startsWith("'"))).toBe(false);
    // Negative sign survives on both money and number columns.
    expect(dataRow).toContain('-');
    expect(dataRow).toContain('-5');
  });

  it('(5) handles formula prefix combined with quotes/commas', () => {
    const table: ReportTable = {
      title: 'T',
      columns: [{ key: 'name', label: 'Имя', kind: 'text' }],
      rows: [
        { name: '=cmd|"/C calc"!A1' }, // formula + embedded quote
        { name: '+a,b' }, // formula prefix + comma
      ],
    };
    const { data } = parse(renderCsv(table));
    // formula neutralized first ('=...), then quote-escaped (doubled quotes).
    expect(data[0]).toBe(`"'=cmd|""/C calc""!A1"`);
    // comma forces CSV quoting; formula prefix applied inside.
    expect(data[1]).toBe(`"'+a,b"`);
  });

  it('neutralizes a formula injected into the report title', () => {
    const table: ReportTable = {
      title: '=HYPERLINK("http://evil")',
      columns: [{ key: 'name', label: 'Имя', kind: 'text' }],
      rows: [],
    };
    const out = rows(renderCsv(table));
    expect(out[0]).toBe(`"'=HYPERLINK(""http://evil"")"`);
  });

  it('preserves BOM and CRLF line endings', () => {
    const table: ReportTable = {
      title: 'A',
      columns: [{ key: 'n', label: 'B', kind: 'text' }],
      rows: [{ n: 'C' }],
    };
    const text = renderCsv(table).toString('utf-8');
    expect(text.startsWith(BOM)).toBe(true);
    expect(text.includes('\r\n')).toBe(true);
  });
});

describe('quoteCsv (regression — existing behavior unchanged)', () => {
  it('quotes delimiters and doubles embedded quotes', () => {
    expect(quoteCsv('plain')).toBe('plain');
    expect(quoteCsv('a,b')).toBe('"a,b"');
    expect(quoteCsv('a;b')).toBe('"a;b"');
    expect(quoteCsv('a\nb')).toBe('"a\nb"');
    expect(quoteCsv('say "hi"')).toBe('"say ""hi"""');
    expect(quoteCsv('')).toBe('');
  });
});
