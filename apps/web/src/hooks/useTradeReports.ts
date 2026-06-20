'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { MarginReport, ReceivablesReport } from '@/lib/types';
import type { PeriodParams } from '@/hooks/useReports';

function buildQuery(params: Record<string, string | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== '');
  if (entries.length === 0) return '';
  return '?' + entries.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
}

export function useMarginReport(
  method: 'by-product' | 'by-client',
  wsId: string | null,
  period: PeriodParams,
) {
  const qs = buildQuery({ preset: period.preset, from: period.from, to: period.to });
  return useQuery({
    queryKey: ['trade-reports', 'margin', method, wsId, qs],
    queryFn: () =>
      api.get<MarginReport>(`/workspaces/${wsId}/trade-reports/margin/${method}${qs}`),
    enabled: !!wsId,
  });
}

export function useReceivables(wsId: string | null, asOf?: string) {
  const qs = buildQuery({ asOf });
  return useQuery({
    queryKey: ['trade-reports', 'receivables', wsId, qs],
    queryFn: () =>
      api.get<ReceivablesReport>(`/workspaces/${wsId}/trade-reports/receivables${qs}`),
    enabled: !!wsId,
  });
}
