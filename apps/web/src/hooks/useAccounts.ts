'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Account, AccountType } from '@/lib/types';

export interface CreateAccountInput {
  name: string;
  type: AccountType;
  openingBalance?: string;
  note?: string;
}

export interface UpdateAccountInput {
  name?: string;
  type?: AccountType;
  openingBalance?: string;
  note?: string | null;
  isArchived?: boolean;
}

export function useAccounts(wsId: string | null, includeArchived = false) {
  return useQuery({
    queryKey: ['accounts', wsId, { includeArchived }],
    queryFn: () =>
      api.get<Account[]>(`/workspaces/${wsId}/accounts?includeArchived=${includeArchived}`),
    enabled: !!wsId,
  });
}

export function useCreateAccount(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAccountInput) =>
      api.post<Account>(`/workspaces/${wsId}/accounts`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['accounts', wsId] }),
  });
}

export function useUpdateAccount(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateAccountInput & { id: string }) =>
      api.patch<Account>(`/workspaces/${wsId}/accounts/${id}`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['accounts', wsId] }),
  });
}

export function useDeleteAccount(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/workspaces/${wsId}/accounts/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['accounts', wsId] }),
  });
}
