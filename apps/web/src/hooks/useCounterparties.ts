'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Counterparty } from '@/lib/types';

export interface CreateCounterpartyInput {
  name: string;
  contact?: string;
  note?: string;
}

export interface UpdateCounterpartyInput {
  name?: string;
  contact?: string | null;
  note?: string | null;
  isArchived?: boolean;
}

export function useCounterparties(wsId: string | null, search?: string, includeArchived = false) {
  return useQuery({
    queryKey: ['counterparties', wsId, { search, includeArchived }],
    queryFn: () => {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      if (includeArchived) params.set('includeArchived', 'true');
      return api.get<Counterparty[]>(`/workspaces/${wsId}/counterparties?${params.toString()}`);
    },
    enabled: !!wsId,
  });
}

export function useCreateCounterparty(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCounterpartyInput) =>
      api.post<Counterparty>(`/workspaces/${wsId}/counterparties`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['counterparties', wsId] }),
  });
}

export function useUpdateCounterparty(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateCounterpartyInput & { id: string }) =>
      api.patch<Counterparty>(`/workspaces/${wsId}/counterparties/${id}`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['counterparties', wsId] }),
  });
}

export function useDeleteCounterparty(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/workspaces/${wsId}/counterparties/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['counterparties', wsId] }),
  });
}
