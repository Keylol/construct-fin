'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, newIdempotencyKey } from '@/lib/api';
import type { WarehouseItem } from '@/lib/types';

export interface CreateWarehouseItemInput {
  name: string;
  sku?: string;
  unit?: string;
  openingQty?: string;
  openingCost?: string;
  defaultSupplierId?: string | null;
  note?: string;
}

export interface UpdateWarehouseItemInput {
  name?: string;
  sku?: string | null;
  unit?: string;
  defaultSupplierId?: string | null;
  note?: string | null;
  isArchived?: boolean;
}

export function useWarehouse(wsId: string | null, search?: string, includeArchived = false) {
  return useQuery({
    queryKey: ['warehouse', wsId, { search, includeArchived }],
    queryFn: () => {
      const p = new URLSearchParams();
      if (search) p.set('search', search);
      if (includeArchived) p.set('includeArchived', 'true');
      return api.get<WarehouseItem[]>(`/workspaces/${wsId}/warehouse?${p.toString()}`);
    },
    enabled: !!wsId,
  });
}

export function useStockValue(wsId: string | null) {
  return useQuery({
    queryKey: ['warehouse-stock-value', wsId],
    queryFn: () => api.get<{ value: string }>(`/workspaces/${wsId}/warehouse/stock-value`),
    enabled: !!wsId,
  });
}

function invalidate(qc: ReturnType<typeof useQueryClient>, wsId: string) {
  qc.invalidateQueries({ queryKey: ['warehouse', wsId] });
  qc.invalidateQueries({ queryKey: ['warehouse-stock-value', wsId] });
}

export function useCreateWarehouseItem(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateWarehouseItemInput) =>
      api.post<WarehouseItem>(`/workspaces/${wsId}/warehouse`, input),
    onSuccess: () => invalidate(qc, wsId),
  });
}

export function useUpdateWarehouseItem(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateWarehouseItemInput & { id: string }) =>
      api.patch<WarehouseItem>(`/workspaces/${wsId}/warehouse/${id}`, input),
    onSuccess: () => invalidate(qc, wsId),
  });
}

export function useAdjustStock(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, newQty, reason }: { id: string; newQty: string; reason?: string }) =>
      api.post<WarehouseItem>(`/workspaces/${wsId}/warehouse/${id}/adjust`, { newQty, reason }),
    onSuccess: () => invalidate(qc, wsId),
  });
}

export function useDeleteWarehouseItem(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/workspaces/${wsId}/warehouse/${id}`),
    onSuccess: () => invalidate(qc, wsId),
  });
}

export interface SupplierReturnInput {
  id: string;
  qty: string;
  refundAmount: string;
  accountId: string;
  supplierId?: string | null;
  date?: string;
  note?: string;
}

export function useSupplierReturn(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: SupplierReturnInput) =>
      api.post<{ item: WarehouseItem; transactionId: string }>(
        `/workspaces/${wsId}/warehouse/${id}/supplier-return`,
        input,
        { idempotencyKey: newIdempotencyKey() },
      ),
    onSuccess: () => {
      invalidate(qc, wsId);
      qc.invalidateQueries({ queryKey: ['transactions', wsId] });
    },
  });
}
