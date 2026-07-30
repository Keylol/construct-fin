'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { IntegrationConnection, IntegrationProvider, SyncResult } from '@/lib/types';

/** Клиентский сертификат mTLS (Альфа): PEM-содержимое файлов. */
export interface TlsInput {
  tlsCert?: string;
  tlsKey?: string;
  tlsPassphrase?: string;
}

export interface CreateIntegrationInput extends TlsInput {
  provider: IntegrationProvider;
  accountId: string;
  token: string;
  /** Номер расчётного счёта у банка (обязателен для банков). */
  accountNumber?: string;
  /** Тянуть выписку с этой даты (YYYY-MM-DD), а не с момента подключения. */
  backfillFrom?: string;
}
export interface UpdateIntegrationInput extends TlsInput {
  id: string;
  token?: string;
  status?: 'ACTIVE' | 'DISABLED';
  accountNumber?: string;
  /** null снимает дату — выгрузка снова начнётся с даты подключения. */
  backfillFrom?: string | null;
}

export function useIntegrations(wsId: string | null) {
  return useQuery({
    queryKey: ['integrations', wsId],
    queryFn: () => api.get<IntegrationConnection[]>(`/workspaces/${wsId}/integrations`),
    enabled: !!wsId,
  });
}

export function useCreateIntegration(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateIntegrationInput) =>
      api.post<IntegrationConnection>(`/workspaces/${wsId}/integrations`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['integrations', wsId] }),
  });
}

export function useUpdateIntegration(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateIntegrationInput) =>
      api.patch<IntegrationConnection>(`/workspaces/${wsId}/integrations/${id}`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['integrations', wsId] }),
  });
}

export interface ResetResult {
  linesDeleted: number;
  transactionsRemoved: number;
  orderPaymentsKept: number;
}

/**
 * «Перезагрузить выписку»: снести загруженное из банка и вытянуть заново —
 * например, после того как завели правила автокатегоризации.
 */
export function useResetIntegration(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<ResetResult>(`/workspaces/${wsId}/integrations/${id}/reset`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['integrations', wsId] });
      qc.invalidateQueries({ queryKey: ['inbox', wsId] });
      qc.invalidateQueries({ queryKey: ['transactions', wsId] });
    },
  });
}

export function useDeleteIntegration(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/workspaces/${wsId}/integrations/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['integrations', wsId] }),
  });
}

export function useSyncIntegration(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<SyncResult>(`/workspaces/${wsId}/integrations/${id}/sync`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['integrations', wsId] });
      // Новые строки могли уехать в Inbox — обновим бейдж/список.
      qc.invalidateQueries({ queryKey: ['inbox', wsId] });
    },
  });
}
