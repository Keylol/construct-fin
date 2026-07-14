'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { InboxPage } from '@/lib/types';

/** Ключ, инвалидируемый после любого действия разбора и после синка. */
const inboxKey = (wsId: string | null) => ['inbox', wsId];

export function useInbox(wsId: string | null) {
  return useQuery({
    queryKey: [...inboxKey(wsId), 'list'],
    queryFn: () => api.get<InboxPage>(`/workspaces/${wsId}/inbox?limit=100`),
    enabled: !!wsId,
  });
}

export function useInboxCount(wsId: string | null) {
  return useQuery({
    queryKey: [...inboxKey(wsId), 'count'],
    queryFn: () => api.get<{ count: number }>(`/workspaces/${wsId}/inbox/count`),
    enabled: !!wsId,
    // Бейдж в навигации — освежаем периодически (фоновый синк раз в час на бэке).
    refetchInterval: 60_000,
  });
}

function useInboxAction<TArgs>(
  wsId: string,
  fn: (args: TArgs) => Promise<unknown>,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: inboxKey(wsId) });
      // Разбор создаёт/снимает проводки и оплаты — освежаем зависимые данные.
      qc.invalidateQueries({ queryKey: ['transactions', wsId] });
      qc.invalidateQueries({ queryKey: ['orders', wsId] });
      qc.invalidateQueries({ queryKey: ['reports'] });
    },
  });
}

export function useCategorizeInbox(wsId: string) {
  return useInboxAction<{
    lineId: string;
    categoryId: string;
    counterpartyId?: string;
    description?: string;
  }>(wsId, ({ lineId, ...body }) =>
    api.post(`/workspaces/${wsId}/inbox/${lineId}/categorize`, body),
  );
}

export function useAttachOrderInbox(wsId: string) {
  return useInboxAction<{ lineId: string; orderId: string }>(wsId, ({ lineId, orderId }) =>
    api.post(`/workspaces/${wsId}/inbox/${lineId}/attach-order`, { orderId }),
  );
}

export function useDismissInbox(wsId: string) {
  return useInboxAction<string>(wsId, (lineId) =>
    api.post(`/workspaces/${wsId}/inbox/${lineId}/dismiss`, {}),
  );
}
