'use client';

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
    <div className="flex gap-2">
      {(['csv', 'xlsx', 'pdf'] as const).map((format) => (
        <a
          key={format}
          href={buildExportUrl(wsId, kind, format, params)}
          className="rounded-md border border-glass-border bg-glass/40 px-3 py-1 text-sm hover:bg-glass/60"
        >
          {format.toUpperCase()}
        </a>
      ))}
    </div>
  );
}
