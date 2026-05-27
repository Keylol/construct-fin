'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Order, OrderStatus } from '@/lib/types';

export interface OrderItemInput {
  warehouseItemId?: string | null;
  name: string;
  qty: string;
  unitPrice: string;
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
      api.post<Order>(`/workspaces/${wsId}/orders/${id}/payments`, input),
    onSuccess: () => invalidate(qc, wsId),
  });
}

export function useRefundOrder(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: RefundInput & { id: string }) =>
      api.post<Order>(`/workspaces/${wsId}/orders/${id}/refund`, input),
    onSuccess: () => invalidate(qc, wsId),
  });
}

export function useFinalizeOrder(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<Order>(`/workspaces/${wsId}/orders/${id}/finalize`),
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

export function useDeleteOrder(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/workspaces/${wsId}/orders/${id}`),
    onSuccess: () => invalidate(qc, wsId),
  });
}
