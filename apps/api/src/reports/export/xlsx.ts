import ExcelJS from 'exceljs';
import { formatCell, type ReportTable } from './report-table';

export async function renderXlsx(table: ReportTable): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Construct';
  wb.created = new Date();
  const ws = wb.addWorksheet('Report');

  let row = 1;
  ws.getCell(`A${row}`).value = table.title;
  ws.getCell(`A${row}`).font = { size: 14, bold: true };
  row++;
  if (table.subtitle) {
    ws.getCell(`A${row}`).value = table.subtitle;
    ws.getCell(`A${row}`).font = { italic: true, color: { argb: 'FF666666' } };
    row++;
  }
  if (table.period) {
    ws.getCell(`A${row}`).value = `Период: ${table.period.from.slice(0, 10)} — ${table.period.to.slice(0, 10)}`;
    ws.getCell(`A${row}`).font = { color: { argb: 'FF666666' } };
    row++;
  }
  row++;

  const headerRow = ws.getRow(row);
  table.columns.forEach((col, idx) => {
    const cell = headerRow.getCell(idx + 1);
    cell.value = col.label;
    cell.font = { bold: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
    cell.border = { bottom: { style: 'thin' } };
    const column = ws.getColumn(idx + 1);
    column.width = col.width ?? Math.max(12, col.label.length + 2);
  });
  row++;

  for (const r of table.rows) {
    const excelRow = ws.getRow(row);
    table.columns.forEach((col, idx) => {
      const cell = excelRow.getCell(idx + 1);
      const raw = r[col.key];
      if (col.kind === 'money' || col.kind === 'number') {
        cell.value = raw === null || raw === undefined || raw === '' ? null : Number(raw);
        if (col.kind === 'money') cell.numFmt = '#,##0.00';
      } else if (col.kind === 'percent') {
        cell.value = raw === null || raw === undefined ? null : Number(raw);
        cell.numFmt = '0.0%';
      } else if (col.kind === 'date') {
        cell.value = raw ? new Date(String(raw)) : null;
        cell.numFmt = 'yyyy-mm-dd';
      } else {
        cell.value = formatCell(raw ?? null, col.kind);
      }
    });
    row++;
  }

  if (table.totals) {
    const totalsRow = ws.getRow(row);
    table.columns.forEach((col, idx) => {
      const cell = totalsRow.getCell(idx + 1);
      cell.font = { bold: true };
      cell.border = { top: { style: 'thin' } };
      if (idx === 0) {
        cell.value = 'Итого';
        return;
      }
      const raw = table.totals![col.key];
      if (col.kind === 'money' || col.kind === 'number') {
        cell.value = raw === null || raw === undefined || raw === '' ? null : Number(raw);
        if (col.kind === 'money') cell.numFmt = '#,##0.00';
      } else if (col.kind === 'percent') {
        cell.value = raw === null || raw === undefined ? null : Number(raw);
        cell.numFmt = '0.0%';
      } else {
        cell.value = formatCell(raw ?? null, col.kind);
      }
    });
  }

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
