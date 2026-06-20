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
      // Перевод создаёт ноги-транзакции и двигает остатки счетов — гасим связанные кэши.
      qc.invalidateQueries({ queryKey: ['transfers', wsId] });
      qc.invalidateQueries({ queryKey: ['transactions', wsId] });
      qc.invalidateQueries({ queryKey: ['accounts', wsId] });
      qc.invalidateQueries({ queryKey: ['reports'] });
    },
  });
}

export function useDeleteTransfer(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/workspaces/${wsId}/transfers/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['transfers', wsId] });
      qc.invalidateQueries({ queryKey: ['transactions', wsId] });
      qc.invalidateQueries({ queryKey: ['accounts', wsId] });
      qc.invalidateQueries({ queryKey: ['reports'] });
    },
  });
}
