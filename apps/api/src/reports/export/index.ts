import type { ExportFormat } from '../reports.dto';
import { renderCsv } from './csv';
import { renderXlsx } from './xlsx';
import { renderPdf } from './pdf';
import type { ReportTable } from './report-table';

export interface ExportedFile {
  buffer: Buffer;
  mimeType: string;
  extension: string;
}

export async function renderReport(
  table: ReportTable,
  format: ExportFormat,
): Promise<ExportedFile> {
  switch (format) {
    case 'csv':
      return {
        buffer: renderCsv(table),
        mimeType: 'text/csv; charset=utf-8',
        extension: 'csv',
      };
    case 'xlsx':
      return {
        buffer: await renderXlsx(table),
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        extension: 'xlsx',
      };
    case 'pdf':
      return {
        buffer: renderPdf(table),
        mimeType: 'application/pdf',
        extension: 'pdf',
      };
  }
}

export type { ReportTable, ReportColumn } from './report-table';
