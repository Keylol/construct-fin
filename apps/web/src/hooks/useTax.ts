'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { TaxPayInput, TaxYearReport } from '@/lib/types';

export function useTaxReport(wsId: string | null, year: number) {
  return useQuery({
    queryKey: ['tax', wsId, year],
    queryFn: () => api.get<TaxYearReport>(`/workspaces/${wsId}/reports/tax?year=${year}`),
    enabled: !!wsId,
  });
}

/** Отметка уплаты налога создаёт TAX-расход → устаревают касса и отчёты. */
function invalidateAfterTax(qc: ReturnType<typeof useQueryClient>, wsId: string) {
  qc.invalidateQueries({ queryKey: ['tax', wsId] });
  qc.invalidateQueries({ queryKey: ['transactions', wsId] });
  qc.invalidateQueries({ queryKey: ['transactions-infinite', wsId] });
  qc.invalidateQueries({ queryKey: ['transactions-summary', wsId] });
  qc.invalidateQueries({ queryKey: ['accounts', wsId] });
  qc.invalidateQueries({ queryKey: ['reports'] });
}

export function usePayTax(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TaxPayInput) =>
      api.post<{ id: string }>(`/workspaces/${wsId}/reports/tax/pay`, input),
    onSuccess: () => invalidateAfterTax(qc, wsId),
  });
}

/** Переопределение АУСН-маркировки операции меняет базу — инвалидируем налог. */
export function useSetAusnMark(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { transactionId: string; ausnMark: 'INCOME' | 'EXPENSE' | 'NOT_COUNTED' | null }) =>
      api.post<{ ok: boolean }>(`/workspaces/${wsId}/reports/tax/ausn`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tax', wsId] });
      qc.invalidateQueries({ queryKey: ['transactions', wsId] });
    },
  });
}