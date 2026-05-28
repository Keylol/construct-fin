'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, newIdempotencyKey } from '@/lib/api';
import type { Order, OrderStatus } from '@/lib/types';

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
  open?: boolean;
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

export interface RefundInput {
  amount: string;
  accountId: string;
  date?: string;
  reason?: string;
}

export function useOrders(
  wsId: string | null,
  filters?: { status?: OrderStatus; clientId?: string; search?: string },
) {
  return useQuery({
    queryKey: ['orders', wsId, filters],
    queryFn: () => {
      const p = new URLSearchParams();
      if (filters?.status) p.set('status', filters.status);
      if (filters?.clientId) p.set('clientId', filters.clientId);
      if (filters?.search) p.set('search', filters.search);
      return api.get<Order[]>(`/workspaces/${wsId}/orders?${p.toString()}`);
    },
    enabled: !!wsId,
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
  return useMutation({
    mutationFn: ({ id, ...input }: AddPaymentInput & { id: string }) =>
      api.post<Order>(`/workspaces/${wsId}/orders/${id}/payments`, input, {
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: () => invalidate(qc, wsId),
  });
}

export function useRefundOrder(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: RefundInput & { id: string }) =>
      api.post<Order>(`/workspaces/${wsId}/orders/${id}/refund`, input, {
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: () => invalidate(qc, wsId),
  });
}

export function useFinalizeOrder(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<Order>(`/workspaces/${wsId}/orders/${id}/finalize`, undefined, {
        idempotencyKey: newIdempotencyKey(),
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

export function useRestoreOrder(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<Order>(`/workspaces/${wsId}/orders/${id}/restore`),
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
