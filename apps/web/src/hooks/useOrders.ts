'use client';

import { useRef } from 'react';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { api, newIdempotencyKey } from '@/lib/api';
import type { Order, OrderListPage, OrderStatus } from '@/lib/types';

export interface OrderItemInput {
  warehouseItemId?: string | null;
  name: string;
  qty: string;
  unitPrice: string;
  unitCost?: string | null;
}

export interface CreateOrderInput {
  clientId?: string | null;
  title?: string;
  description?: string;
  discountAmount?: string;
  expectedDate?: string | null;
  items: OrderItemInput[];
}

export interface UpdateOrderInput {
  clientId?: string | null;
  title?: string | null;
  description?: string | null;
  discountAmount?: string;
  expectedDate?: string | null;
  items?: OrderItemInput[];
}

export interface AddPaymentInput {
  amount: string;
  accountId: string;
  date?: string;
  description?: string;
}

/**
 * Список заказов с курсор-пагинацией («Загрузить ещё»). Бэк отдаёт
 * { items, nextCursor }. queryKey содержит фильтры — их смена сбрасывает страницы.
 */
export function useOrders(
  wsId: string | null,
  filters?: { status?: OrderStatus; clientId?: string; search?: string; limit?: number },
) {
  return useInfiniteQuery({
    queryKey: ['orders', wsId, filters],
    enabled: !!wsId,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams();
      if (filters?.status) p.set('status', filters.status);
      if (filters?.clientId) p.set('clientId', filters.clientId);
      if (filters?.search) p.set('search', filters.search);
      if (filters?.limit) p.set('limit', String(filters.limit));
      if (pageParam) p.set('cursor', pageParam);
      return api.get<OrderListPage>(`/workspaces/${wsId}/orders?${p.toString()}`);
    },
    getNextPageParam: (last) => last.nextCursor,
  });
}

export function useOrder(wsId: string | null, id: string | null) {
  return useQuery({
    queryKey: ['order', wsId, id],
    queryFn: () => api.get<Order>(`/workspaces/${wsId}/orders/${id}`),
    enabled: !!wsId && !!id,
  });
}

function invalidate(qc: ReturnType<typeof useQueryClient>, wsId: string) {
  qc.invalidateQueries({ queryKey: ['orders', wsId] });
  qc.invalidateQueries({ queryKey: ['order', wsId] });
  qc.invalidateQueries({ queryKey: ['transactions', wsId] });
  // Денежные операции по заказу затрагивают кэш-флоу/P&L, торговые отчёты,
  // KPI/summary, ленту операций, склад (COGS), сверку и остатки по счетам.
  qc.invalidateQueries({ queryKey: ['transactions-infinite', wsId] });
  qc.invalidateQueries({ queryKey: ['transactions-summary', wsId] });
  qc.invalidateQueries({ queryKey: ['reports'] });
  qc.invalidateQueries({ queryKey: ['trade-reports'] });
  qc.invalidateQueries({ queryKey: ['warehouse', wsId] });
  qc.invalidateQueries({ queryKey: ['warehouse-stock-value', wsId] });
  qc.invalidateQueries({ queryKey: ['reconciliation'] });
  qc.invalidateQueries({ queryKey: ['accounts', wsId] });
}

export function useCreateOrder(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateOrderInput) =>
      api.post<Order>(`/workspaces/${wsId}/orders`, input),
    onSuccess: () => invalidate(qc, wsId),
  });
}

export function useUpdateOrder(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateOrderInput & { id: string }) =>
      api.patch<Order>(`/workspaces/${wsId}/orders/${id}`, input),
    onSuccess: () => invalidate(qc, wsId),
  });
}

export function useAddOrderPayment(wsId: string) {
  const qc = useQueryClient();
  // M18: ключ фиксируется ОДИН раз на логическую операцию в onMutate (срабатывает
  // один раз на mutate, НЕ на каждый retry mutationFn) и переиспользуется при
  // повторах той же мутации. Новый вызов mutate() → новый onMutate → новый ключ.
  const idemKey = useRef('');
  return useMutation({
    onMutate: () => {
      idemKey.current = newIdempotencyKey();
    },
    mutationFn: ({ id, ...input }: AddPaymentInput & { id: string }) =>
      api.post<Order>(`/workspaces/${wsId}/orders/${id}/payments`, input, {
        idempotencyKey: idemKey.current,
      }),
    onSuccess: () => invalidate(qc, wsId),
  });
}

export function useFinalizeOrder(wsId: string) {
  const qc = useQueryClient();
  // M18: см. useAddOrderPayment — ключ стабилен на время операции (retry не задвоит).
  const idemKey = useRef('');
  return useMutation({
    onMutate: () => {
      idemKey.current = newIdempotencyKey();
    },
    mutationFn: (id: string) =>
      api.post<Order>(`/workspaces/${wsId}/orders/${id}/finalize`, undefined, {
        idempotencyKey: idemKey.current,
      }),
    onSuccess: () => invalidate(qc, wsId),
  });
}

export function useCancelOrder(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<Order>(`/workspaces/${wsId}/orders/${id}/cancel`),
    onSuccess: () => invalidate(qc, wsId),
  });
}

export function useReopenOrder(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<Order>(`/workspaces/${wsId}/orders/${id}/reopen`),
    onSuccess: () => invalidate(qc, wsId),
  });
}

export function useDeleteOrder(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/workspaces/${wsId}/orders/${id}`),
    onSuccess: () => invalidate(qc, wsId),
  });
}

// ─────────── Вложения заказа (чеки) ───────────

export function useUploadOrderAttachment(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ orderId, file }: { orderId: string; file: File }) => {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(`/api/v1/workspaces/${wsId}/orders/${orderId}/attachments`, {
        method: 'POST',
        credentials: 'include',
        body: form,
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(data.message || `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['order', wsId] }),
  });
}

export function useDeleteOrderAttachment(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (attachmentId: string) =>
      api.del(`/workspaces/${wsId}/attachments/${attachmentId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['order', wsId] }),
  });
}
