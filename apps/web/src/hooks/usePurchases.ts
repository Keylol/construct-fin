'use client';

import { useRef } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, newIdempotencyKey } from '@/lib/api';
import type { Purchase } from '@/lib/types';

export interface PurchaseLineInput {
  warehouseItemId: string;
  qty: string;
  unitPrice: string;
}

export interface CreatePurchaseInput {
  accountId: string;
  supplierId?: string | null;
  date?: string;
  note?: string;
  lines: PurchaseLineInput[];
}

export interface PurchaseListFilters {
  /** Поставщик, позиция, комментарий или сумма — ищет сервер (docs/search.md). */
  search?: string;
  /** Период по дате закупки, ISO. */
  from?: string;
  to?: string;
}

export function usePurchases(
  wsId: string | null,
  supplierId?: string,
  filters: PurchaseListFilters = {},
) {
  const search = filters.search?.trim() || undefined;
  return useQuery({
    queryKey: ['purchases', wsId, { supplierId, search, from: filters.from, to: filters.to }],
    queryFn: () => {
      const p = new URLSearchParams();
      if (supplierId) p.set('supplierId', supplierId);
      if (search) p.set('search', search);
      if (filters.from) p.set('from', filters.from);
      if (filters.to) p.set('to', filters.to);
      return api.get<Purchase[]>(`/workspaces/${wsId}/purchases?${p.toString()}`);
    },
    enabled: !!wsId,
    // Смена поиска не «моргает» пустой таблицей — держим прошлые данные.
    placeholderData: keepPreviousData,
  });
}

/** Одна закупка по id — когда её нет в текущем списке (открыли из общего поиска). */
export function usePurchase(wsId: string | null, id: string | null) {
  return useQuery({
    queryKey: ['purchases', wsId, 'one', id],
    queryFn: () => api.get<Purchase>(`/workspaces/${wsId}/purchases/${id}`),
    enabled: !!wsId && !!id,
  });
}

/** GH9: отменить закупку (только нетронутые партии). */
export function useVoidPurchase(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (purchaseId: string) =>
      api.del<{ ok: boolean }>(`/workspaces/${wsId}/purchases/${purchaseId}`),
    onSuccess: () => {
      // Тот же набор кэшей, что и создание закупки — склад/деньги/отчёты.
      qc.invalidateQueries({ queryKey: ['purchases', wsId] });
      qc.invalidateQueries({ queryKey: ['warehouse', wsId] });
      qc.invalidateQueries({ queryKey: ['warehouse-stock-value', wsId] });
      qc.invalidateQueries({ queryKey: ['transactions', wsId] });
      qc.invalidateQueries({ queryKey: ['transactions-infinite', wsId] });
      qc.invalidateQueries({ queryKey: ['transactions-summary', wsId] });
      qc.invalidateQueries({ queryKey: ['reports'] });
      qc.invalidateQueries({ queryKey: ['trade-reports'] });
      qc.invalidateQueries({ queryKey: ['reconciliation'] });
      qc.invalidateQueries({ queryKey: ['accounts', wsId] });
    },
  });
}

export function useCreatePurchase(wsId: string) {
  const qc = useQueryClient();
  // M18: ключ фиксируется один раз на операцию в onMutate (см. useOrders) —
  // стабилен при retry той же мутации, новый mutate() даёт новый ключ.
  const idemKey = useRef('');
  return useMutation({
    onMutate: () => {
      idemKey.current = newIdempotencyKey();
    },
    mutationFn: (input: CreatePurchaseInput) =>
      api.post<Purchase>(`/workspaces/${wsId}/purchases`, input, {
        idempotencyKey: idemKey.current,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['purchases', wsId] });
      qc.invalidateQueries({ queryKey: ['warehouse', wsId] });
      qc.invalidateQueries({ queryKey: ['warehouse-stock-value', wsId] });
      qc.invalidateQueries({ queryKey: ['transactions', wsId] });
      // Закупка списывает деньги со счёта → лента/KPI/отчёты/сверка/остатки.
      qc.invalidateQueries({ queryKey: ['transactions-infinite', wsId] });
      qc.invalidateQueries({ queryKey: ['transactions-summary', wsId] });
      qc.invalidateQueries({ queryKey: ['reports'] });
      qc.invalidateQueries({ queryKey: ['trade-reports'] });
      qc.invalidateQueries({ queryKey: ['reconciliation'] });
      qc.invalidateQueries({ queryKey: ['accounts', wsId] });
    },
  });
}
