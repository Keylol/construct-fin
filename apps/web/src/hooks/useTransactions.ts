'use client';

import { useRef } from 'react';
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { api, newIdempotencyKey } from '@/lib/api';
import type {
  Transaction,
  TransactionWithAttachments,
  TransactionListPage,
  TransactionSummary,
  TxType,
  AttachmentSummary,
} from '@/lib/types';

export interface TransactionFilters {
  from?: string;
  to?: string;
  accountId?: string;
  categoryId?: string;
  counterpartyId?: string;
  type?: TxType;
  minAmount?: string;
  maxAmount?: string;
  search?: string;
  cursor?: string;
  limit?: number;
}

export interface CreateTransactionInput {
  date: string;
  amount: string;
  type: TxType;
  accountId: string;
  categoryId?: string | null;
  counterpartyId?: string | null;
  description?: string;
}

export interface UpdateTransactionInput {
  date?: string;
  amount?: string;
  type?: TxType;
  accountId?: string;
  categoryId?: string | null;
  counterpartyId?: string | null;
  description?: string | null;
}

function buildQS(filters: TransactionFilters): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (v === undefined || v === null || v === '') continue;
    p.set(k, String(v));
  }
  return p.toString();
}

export function useTransactions(wsId: string | null, filters: TransactionFilters = {}) {
  return useQuery({
    queryKey: ['transactions', wsId, filters],
    queryFn: () =>
      api.get<TransactionListPage>(`/workspaces/${wsId}/transactions?${buildQS(filters)}`),
    enabled: !!wsId,
    // Смена поиска/фильтров не «моргает» пустой таблицей — держим прошлые данные.
    placeholderData: keepPreviousData,
  });
}

/**
 * Курсор-пагинация операций («Загрузить ещё») — бэк отдаёт nextCursor.
 * `cursor` из filters игнорируется (его ведёт pageParam). queryKey содержит
 * остальные фильтры, поэтому смена периода/фильтра сбрасывает пагинацию.
 */
export function useInfiniteTransactions(wsId: string | null, filters: TransactionFilters = {}) {
  // cursor исключаем из ключа/базовых фильтров — им управляет pageParam.
  const { cursor: _cursor, ...base } = filters;
  return useInfiniteQuery({
    queryKey: ['transactions-infinite', wsId, base],
    enabled: !!wsId,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api.get<TransactionListPage>(
        `/workspaces/${wsId}/transactions?${buildQS({ ...base, cursor: pageParam ?? undefined })}`,
      ),
    getNextPageParam: (last) => last.nextCursor,
  });
}

export function useTransaction(wsId: string | null, id: string | null) {
  return useQuery({
    queryKey: ['transaction', wsId, id],
    queryFn: () =>
      api.get<TransactionWithAttachments>(`/workspaces/${wsId}/transactions/${id}`),
    enabled: !!wsId && !!id,
  });
}

export function useTransactionSummary(
  wsId: string | null,
  range: { from?: string; to?: string } = {},
) {
  return useQuery({
    queryKey: ['transactions-summary', wsId, range],
    queryFn: () =>
      api.get<TransactionSummary>(`/workspaces/${wsId}/transactions/summary?${buildQS(range)}`),
    enabled: !!wsId,
  });
}

export function useCreateTransaction(wsId: string) {
  const qc = useQueryClient();
  // C6: денежный POST — ключ идемпотентности против двойного сабмита формы.
  const idemKey = useRef('');
  return useMutation({
    onMutate: () => {
      idemKey.current = newIdempotencyKey();
    },
    mutationFn: (input: CreateTransactionInput) =>
      api.post<Transaction>(`/workspaces/${wsId}/transactions`, input, {
        idempotencyKey: idemKey.current,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['transactions', wsId] });
      qc.invalidateQueries({ queryKey: ['transactions-infinite', wsId] });
      qc.invalidateQueries({ queryKey: ['transactions-summary', wsId] });
      qc.invalidateQueries({ queryKey: ['reports'] });
      qc.invalidateQueries({ queryKey: ['reconciliation'] });
    },
  });
}

export function useUpdateTransaction(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateTransactionInput & { id: string }) =>
      api.patch<Transaction>(`/workspaces/${wsId}/transactions/${id}`, input),
    onSuccess: (_data, { id }) => {
      qc.invalidateQueries({ queryKey: ['transactions', wsId] });
      qc.invalidateQueries({ queryKey: ['transactions-infinite', wsId] });
      qc.invalidateQueries({ queryKey: ['transactions-summary', wsId] });
      qc.invalidateQueries({ queryKey: ['transaction', wsId, id] });
      qc.invalidateQueries({ queryKey: ['reports'] });
      qc.invalidateQueries({ queryKey: ['reconciliation'] });
    },
  });
}

export function useDeleteTransaction(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/workspaces/${wsId}/transactions/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['transactions', wsId] });
      qc.invalidateQueries({ queryKey: ['transactions-infinite', wsId] });
      qc.invalidateQueries({ queryKey: ['transactions-summary', wsId] });
      qc.invalidateQueries({ queryKey: ['reports'] });
      qc.invalidateQueries({ queryKey: ['reconciliation'] });
    },
  });
}

export function useUploadAttachment(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ txId, file }: { txId: string; file: File }) => {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`/api/v1/workspaces/${wsId}/transactions/${txId}/attachments`, {
        method: 'POST',
        credentials: 'include',
        body: fd,
      });
      if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
      return (await res.json()) as AttachmentSummary;
    },
    onSuccess: (_d, { txId }) => qc.invalidateQueries({ queryKey: ['transaction', wsId, txId] }),
  });
}

export function useDeleteAttachment(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string; txId: string }) =>
      api.del(`/workspaces/${wsId}/attachments/${id}`),
    onSuccess: (_d, { txId }) => qc.invalidateQueries({ queryKey: ['transaction', wsId, txId] }),
  });
}
