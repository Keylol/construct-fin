'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Counterparty, CounterpartyRole } from '@/lib/types';

export interface CreateCounterpartyInput {
  name: string;
  role?: CounterpartyRole;
  contact?: string;
  note?: string;
  inn?: string;
  source?: string;
  position?: string;
  payRate?: string;
}

export interface UpdateCounterpartyInput {
  name?: string;
  role?: CounterpartyRole;
  contact?: string | null;
  note?: string | null;
  inn?: string | null;
  source?: string | null;
  position?: string | null;
  payRate?: string | null;
  isArchived?: boolean;
}

export function useCounterparties(
  wsId: string | null,
  search?: string,
  includeArchived = false,
  role?: CounterpartyRole,
) {
  return useQuery({
    queryKey: ['counterparties', wsId, { search, includeArchived, role }],
    queryFn: () => {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      if (includeArchived) params.set('includeArchived', 'true');
      if (role) params.set('role', role);
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
