'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { BalanceCheck, ReconciliationReport } from '@/lib/types';

export interface CreateCheckInput {
  accountId: string;
  date: string;
  actualBalance: string;
  note?: string;
}

function buildQuery(params: Record<string, string | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== '');
  if (entries.length === 0) return '';
  return '?' + entries.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
}

export function useReconciliation(
  wsId: string | null,
  accountId: string | null,
  asOf?: string,
) {
  const qs = buildQuery({ accountId: accountId ?? undefined, asOf });
  return useQuery({
    queryKey: ['reconciliation', 'report', wsId, accountId, asOf],
    queryFn: () =>
      api.get<ReconciliationReport>(`/workspaces/${wsId}/reconciliation${qs}`),
    enabled: !!wsId && !!accountId,
  });
}

export function useBalanceChecks(wsId: string | null, accountId: string | null) {
  const qs = buildQuery({ accountId: accountId ?? undefined });
  return useQuery({
    queryKey: ['reconciliation', 'checks', wsId, accountId],
    queryFn: () =>
      api.get<BalanceCheck[]>(`/workspaces/${wsId}/reconciliation/checks${qs}`),
    enabled: !!wsId,
  });
}

export function useCreateBalanceCheck(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCheckInput) =>
      api.post<BalanceCheck>(`/workspaces/${wsId}/reconciliation/checks`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['reconciliation'] }),
  });
}

export function useDeleteBalanceCheck(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.del(`/workspaces/${wsId}/reconciliation/checks/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['reconciliation'] }),
  });
}
