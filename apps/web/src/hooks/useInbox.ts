'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { ApplyRulesResult, BankLineStatus, InboxPage } from '@/lib/types';

/** Ключ, инвалидируемый после любого действия разбора и после синка. */
const inboxKey = (wsId: string | null) => ['inbox', wsId];

/**
 * Строки выписки выбранного статуса. Постранично: после перезалива истории строк
 * бывает больше сотни, а одной страницей хвост просто не виден.
 */
export function useInbox(wsId: string | null, status: BankLineStatus = 'NEW') {
  return useInfiniteQuery({
    queryKey: [...inboxKey(wsId), 'list', status],
    queryFn: ({ pageParam }) =>
      api.get<InboxPage>(
        `/workspaces/${wsId}/inbox?limit=100&status=${status}` +
          (pageParam ? `&cursor=${pageParam}` : ''),
      ),
    initialPageParam: '' as string,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
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

/** Отменить проведение: снять проводку, вернуть строку на разбор. */
export function useUndoInbox(wsId: string) {
  return useInboxAction<string>(wsId, (lineId) =>
    api.post(`/workspaces/${wsId}/inbox/${lineId}/undo`, {}),
  );
}

/**
 * Прогнать правила по строкам, уже лежащим на разборе. Правила срабатывают только
 * при приезде строки, поэтому набор правил, заведённый позже, без этого не действует.
 */
export function useApplyRules(wsId: string) {
  return useInboxAction<void>(wsId, () =>
    api.post<ApplyRulesResult>(`/workspaces/${wsId}/inbox/apply-rules`, {}),
  );
}

/** Массовый откат авто-проведённого — списком строк либо целиком по правилу. */
export function useUndoBulk(wsId: string) {
  return useInboxAction<{ lineIds?: string[]; appliedRuleId?: string }>(wsId, (body) =>
    api.post<{ undone: number; skipped: number }>(
      `/workspaces/${wsId}/inbox/undo-bulk`,
      body,
    ),
  );
}
