'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Transfer } from '@/lib/types';

export interface CreateTransferInput {
  fromAccountId: string;
  toAccountId: string;
  amount: string;
  fee?: string;
  date: string;
  note?: string;
}

export function useTransfers(wsId: string | null) {
  return useQuery({
    queryKey: ['transfers', wsId],
    queryFn: () => api.get<Transfer[]>(`/workspaces/${wsId}/transfers`),
    enabled: !!wsId,
  });
}

export function useCreateTransfer(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTransferInput) =>
      api.post<Transfer>(`/workspaces/${wsId}/transfers`, input),
    onSuccess: () => {
      // Перевод создаёт ноги-транзакции (+ комиссию) и двигает остатки счетов —
      // гасим все связанные кэши (по образцу useOrders/usePurchases): лента,
      // KPI/summary, кэш-флоу/P&L, торговые отчёты, сверка, остатки по счетам.
      qc.invalidateQueries({ queryKey: ['transfers', wsId] });
      qc.invalidateQueries({ queryKey: ['transactions', wsId] });
      qc.invalidateQueries({ queryKey: ['transactions-infinite', wsId] });
      qc.invalidateQueries({ queryKey: ['transactions-summary', wsId] });
      qc.invalidateQueries({ queryKey: ['reports'] });
      qc.invalidateQueries({ queryKey: ['trade-reports'] });
      qc.invalidateQueries({ queryKey: ['reconciliation'] });
      qc.invalidateQueries({ queryKey: ['accounts', wsId] });
    },
  });
}

export function useDeleteTransfer(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/workspaces/${wsId}/transfers/${id}`),
    onSuccess: () => {
      // Удаление перевода сторнирует ноги-транзакции и остатки — гасим тот же
      // набор кэшей, что и при создании.
      qc.invalidateQueries({ queryKey: ['transfers', wsId] });
      qc.invalidateQueries({ queryKey: ['transactions', wsId] });
      qc.invalidateQueries({ queryKey: ['transactions-infinite', wsId] });
      qc.invalidateQueries({ queryKey: ['transactions-summary', wsId] });
      qc.invalidateQueries({ queryKey: ['reports'] });
      qc.invalidateQueries({ queryKey: ['trade-reports'] });
      qc.invalidateQueries({ queryKey: ['reconciliation'] });
      qc.invalidateQueries({ queryKey: ['accounts', wsId] });
    },
  });
}
