'use client';

import { Download } from '@/components/ui/icons';
import { buildExportUrl } from '@/hooks/useReports';

export function ExportButtons({
  wsId,
  kind,
  params,
}: {
  wsId: string;
  kind: 'pnl' | 'cashflow' | 'by-category' | 'by-counterparty';
  params: Record<string, string | undefined>;
}) {
  return (
    <div className="inline-flex divide-x divide-input overflow-hidden rounded-md border border-input">
      {(['csv', 'xlsx'] as const).map((format) => (
        <a
          key={format}
          href={buildExportUrl(wsId, kind, format, params)}
          className="inline-flex h-9 items-center gap-1.5 bg-background px-3 text-xs font-medium uppercase tracking-wide transition-colors hover:bg-secondary"
        >
          {format === 'csv' && <Download className="h-3 w-3" />}
          {format}
        </a>
      ))}
    </div>
  );
}
