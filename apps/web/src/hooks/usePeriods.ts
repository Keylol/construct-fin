'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export type PeriodStatus = 'OPEN' | 'CLOSED';

export interface AccountingPeriod {
  id: string;
  year: number;
  month: number;
  status: PeriodStatus;
  closedAt: string | null;
  closedById: string | null;
  note: string | null;
}

export function usePeriods(wsId: string | null, year?: number) {
  return useQuery({
    queryKey: ['periods', wsId, year],
    queryFn: () => {
      const q = year ? `?year=${year}` : '';
      return api.get<AccountingPeriod[]>(`/workspaces/${wsId}/periods${q}`);
    },
    enabled: !!wsId,
  });
}

export function useClosePeriod(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { year: number; month: number; note?: string | null }) =>
      api.post<AccountingPeriod>(`/workspaces/${wsId}/periods/close`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['periods', wsId] }),
  });
}

export function useReopenPeriod(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { year: number; month: number }) =>
      api.post<AccountingPeriod>(`/workspaces/${wsId}/periods/reopen`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['periods', wsId] }),
  });
}
