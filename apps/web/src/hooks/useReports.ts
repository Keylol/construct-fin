'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type {
  BalanceReport,
  BreakdownReport,
  BreakevenReport,
  CashflowReport,
  CompareMode,
  PeriodPreset,
  PnlReport,
} from '@/lib/types';

export interface PeriodParams {
  preset?: PeriodPreset;
  from?: string;
  to?: string;
}

function buildQuery(params: Record<string, string | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== '');
  if (entries.length === 0) return '';
  return '?' + entries.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
}

export function usePnlReport(
  wsId: string | null,
  period: PeriodParams,
  groupBy: 'month' | 'quarter',
  compareWith: CompareMode,
) {
  const qs = buildQuery({
    preset: period.preset,
    from: period.from,
    to: period.to,
    groupBy,
    compareWith,
  });
  return useQuery({
    queryKey: ['reports', 'pnl', wsId, qs],
    queryFn: () => api.get<PnlReport>(`/workspaces/${wsId}/reports/pnl${qs}`),
    enabled: !!wsId,
  });
}

/** Управленческий баланс «на сейчас» — без параметров периода. */
export function useBalanceReport(wsId: string | null) {
  return useQuery({
    queryKey: ['reports', 'balance', wsId],
    queryFn: () => api.get<BalanceReport>(`/workspaces/${wsId}/reports/balance`),
    enabled: !!wsId,
  });
}

/** Точка безубыточности за период. */
export function useBreakevenReport(wsId: string | null, period: PeriodParams) {
  const qs = buildQuery({ preset: period.preset, from: period.from, to: period.to });
  return useQuery({
    queryKey: ['reports', 'breakeven', wsId, qs],
    queryFn: () => api.get<BreakevenReport>(`/workspaces/${wsId}/reports/breakeven${qs}`),
    enabled: !!wsId,
  });
}

export function useCashflowReport(
  wsId: string | null,
  period: PeriodParams,
  accountId: string | null,
) {
  const qs = buildQuery({
    preset: period.preset,
    from: period.from,
    to: period.to,
    accountId: accountId ?? undefined,
  });
  return useQuery({
    queryKey: ['reports', 'cashflow', wsId, qs],
    queryFn: () => api.get<CashflowReport>(`/workspaces/${wsId}/reports/cashflow${qs}`),
    enabled: !!wsId,
  });
}

export function useBreakdownReport(
  kind: 'by-category' | 'by-counterparty',
  wsId: string | null,
  period: PeriodParams,
  type: 'INCOME' | 'EXPENSE' | 'ALL',
) {
  const qs = buildQuery({
    preset: period.preset,
    from: period.from,
    to: period.to,
    type,
  });
  return useQuery({
    queryKey: ['reports', kind, wsId, qs],
    queryFn: () => api.get<BreakdownReport>(`/workspaces/${wsId}/reports/${kind}${qs}`),
    enabled: !!wsId,
  });
}

export function buildExportUrl(
  wsId: string,
  kind: 'pnl' | 'cashflow' | 'by-category' | 'by-counterparty',
  format: 'csv' | 'xlsx',
  params: Record<string, string | undefined>,
): string {
  const qs = buildQuery({ ...params, format });
  return `/api/v1/workspaces/${wsId}/reports/${kind}/export${qs}`;
}
