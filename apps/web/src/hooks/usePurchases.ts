'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
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

export function usePurchases(wsId: string | null, supplierId?: string) {
  return useQuery({
    queryKey: ['purchases', wsId, { supplierId }],
    queryFn: () => {
      const p = new URLSearchParams();
      if (supplierId) p.set('supplierId', supplierId);
      return api.get<Purchase[]>(`/workspaces/${wsId}/purchases?${p.toString()}`);
    },
    enabled: !!wsId,
  });
}

export function useCreatePurchase(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePurchaseInput) =>
      api.post<Purchase>(`/workspaces/${wsId}/purchases`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['purchases', wsId] });
      qc.invalidateQueries({ queryKey: ['warehouse', wsId] });
      qc.invalidateQueries({ queryKey: ['warehouse-stock-value', wsId] });
      qc.invalidateQueries({ queryKey: ['transactions', wsId] });
    },
  });
}
