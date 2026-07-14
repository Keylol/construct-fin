'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { WbCommitInput, WbReceiptListItem, WbReceiptPreview } from '@/lib/types';

/** Превью чека: multipart PDF → разбор + кандидаты-операции. Ничего не пишет. */
export function useWbReceiptPreview(wsId: string) {
  return useMutation({
    mutationFn: async (input: { file: File; accountId: string }): Promise<WbReceiptPreview> => {
      const fd = new FormData();
      fd.append('file', input.file);
      const res = await fetch(
        `/api/v1/workspaces/${wsId}/wb-receipts/preview?accountId=${input.accountId}`,
        { method: 'POST', credentials: 'include', body: fd },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `Не удалось разобрать чек (HTTP ${res.status})`);
      }
      return (await res.json()) as WbReceiptPreview;
    },
  });
}

/** Разбор трогает деньги, заказы, склад и отчёты — инвалидируем широко. */
function invalidateAfterReceipt(qc: ReturnType<typeof useQueryClient>, wsId: string) {
  qc.invalidateQueries({ queryKey: ['wb-receipts', wsId] });
  qc.invalidateQueries({ queryKey: ['transactions', wsId] });
  qc.invalidateQueries({ queryKey: ['transactions-infinite', wsId] });
  qc.invalidateQueries({ queryKey: ['transactions-summary', wsId] });
  qc.invalidateQueries({ queryKey: ['orders', wsId] });
  qc.invalidateQueries({ queryKey: ['warehouse', wsId] });
  qc.invalidateQueries({ queryKey: ['accounts', wsId] });
  qc.invalidateQueries({ queryKey: ['reports'] });
  qc.invalidateQueries({ queryKey: ['trade-reports'] });
}

export function useCommitWbReceipt(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: WbCommitInput) =>
      api.post<WbReceiptListItem>(`/workspaces/${wsId}/wb-receipts`, input),
    onSuccess: () => invalidateAfterReceipt(qc, wsId),
  });
}

export function useWbReceipts(wsId: string | null) {
  return useQuery({
    queryKey: ['wb-receipts', wsId],
    queryFn: () => api.get<WbReceiptListItem[]>(`/workspaces/${wsId}/wb-receipts`),
    enabled: !!wsId,
  });
}

/** Откат разбора целиком (партии + позиции заказов + деньги). */
export function useRevertWbReceipt(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (receiptId: string) =>
      api.del<{ reverted: number }>(`/workspaces/${wsId}/wb-receipts/${receiptId}`),
    onSuccess: () => invalidateAfterReceipt(qc, wsId),
  });
}
