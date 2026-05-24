import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { formatCell, type ReportTable } from './report-table';

let cachedFont: string | null = null;

function loadDejaVuBase64(): string {
  if (cachedFont) return cachedFont;
  const pkgPath = require.resolve('dejavu-fonts-ttf/package.json');
  const ttfPath = join(dirname(pkgPath), 'ttf', 'DejaVuSans.ttf');
  cachedFont = readFileSync(ttfPath).toString('base64');
  return cachedFont;
}

export function renderPdf(table: ReportTable): Buffer {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt' });
  doc.addFileToVFS('DejaVuSans.ttf', loadDejaVuBase64());
  doc.addFont('DejaVuSans.ttf', 'DejaVu', 'normal');
  doc.setFont('DejaVu', 'normal');

  doc.setFontSize(16);
  doc.text(table.title, 40, 50);

  doc.setFontSize(10);
  let metaY = 70;
  if (table.subtitle) {
    doc.text(table.subtitle, 40, metaY);
    metaY += 14;
  }
  if (table.period) {
    doc.text(
      `Период: ${table.period.from.slice(0, 10)} — ${table.period.to.slice(0, 10)}`,
      40,
      metaY,
    );
    metaY += 6;
  }

  const head = [table.columns.map((c) => c.label)];
  const body = table.rows.map((r) =>
    table.columns.map((c) => formatCell(r[c.key] ?? null, c.kind)),
  );
  const foot = table.totals
    ? [
        table.columns.map((c, idx) =>
          idx === 0 ? 'Итого' : formatCell(table.totals![c.key] ?? null, c.kind),
        ),
      ]
    : undefined;

  autoTable(doc, {
    startY: metaY + 6,
    head,
    body,
    foot,
    styles: { font: 'DejaVu', fontSize: 9, cellPadding: 4 },
    headStyles: { font: 'DejaVu', fillColor: [239, 239, 239], textColor: 20, fontSize: 9 },
    footStyles: { font: 'DejaVu', fillColor: [239, 239, 239], textColor: 20, fontSize: 9 },
    theme: 'grid',
  });

  return Buffer.from(doc.output('arraybuffer'));
}
