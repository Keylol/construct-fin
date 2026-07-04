'use client';

import { useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, newIdempotencyKey } from '@/lib/api';
import type { OpenLotView, WarehouseItem } from '@/lib/types';

export interface CreateWarehouseItemInput {
  name: string;
  sku?: string;
  color?: string | null;
  unit?: string;
  openingQty?: string;
  openingCost?: string;
  defaultSupplierId?: string | null;
  note?: string;
}

export interface UpdateWarehouseItemInput {
  name?: string;
  sku?: string | null;
  color?: string | null;
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
  qc.invalidateQueries({ queryKey: ['warehouse-lots', wsId] });
}

/** F5: открытые партии позиции — «что лежит и откуда» (поставщик/счёт закупки). */
export function useItemLots(wsId: string | null, itemId: string | null) {
  return useQuery({
    queryKey: ['warehouse-lots', wsId, itemId],
    queryFn: () => api.get<OpenLotView[]>(`/workspaces/${wsId}/warehouse/${itemId}/lots`),
    enabled: !!wsId && !!itemId,
  });
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

/**
 * Установка себестоимости начального остатка (для позиций с avgCost=0, qty>0).
 * Деньги не двигаются — корректировка оценки. Бэкенд: POST /warehouse/:id/set-cost.
 */
export function useSetItemCost(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, unitCost, reason }: { id: string; unitCost: string; reason?: string }) =>
      api.post<WarehouseItem>(`/workspaces/${wsId}/warehouse/${id}/set-cost`, { unitCost, reason }),
    onSuccess: () => invalidate(qc, wsId),
  });
}

/**
 * F4: списание со склада (брак/порча/недостача). FIFO-списание партий +
 * неденежная проводка-убыток → трогает и склад, и P&L/ленту операций.
 */
export function useWriteOffStock(wsId: string) {
  const qc = useQueryClient();
  // F6: денежный POST (списание + проводка-убыток) — ключ идемпотентности, чтобы
  // ретрай не задвоил списание склада и проводку.
  const idemKey = useRef('');
  return useMutation({
    onMutate: () => {
      idemKey.current = newIdempotencyKey();
    },
    mutationFn: ({ id, qty, reason }: { id: string; qty: string; reason: string }) =>
      api.post<WarehouseItem>(`/workspaces/${wsId}/warehouse/${id}/write-off`, { qty, reason }, {
        idempotencyKey: idemKey.current,
      }),
    onSuccess: () => {
      invalidate(qc, wsId);
      qc.invalidateQueries({ queryKey: ['transactions', wsId] });
      qc.invalidateQueries({ queryKey: ['transactions-infinite', wsId] });
      qc.invalidateQueries({ queryKey: ['transactions-summary', wsId] });
      qc.invalidateQueries({ queryKey: ['reports'] });
    },
  });
}

export function useDeleteWarehouseItem(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/workspaces/${wsId}/warehouse/${id}`),
    onSuccess: () => invalidate(qc, wsId),
  });
}

