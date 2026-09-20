'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type {
  CrmConnection,
  CrmDeal,
  CrmDealsPage,
  CrmDealsTab,
  CrmPipeline,
  CrmSummary,
  CrmSyncResult,
} from '@/lib/types';

/** Один корень ключей: любое действие со сделкой обновляет и список, и итоги. */
const crmKey = (wsId: string | null) => ['crm', wsId] as const;

export interface CrmDealsFilters {
  tab: CrmDealsTab;
  search?: string;
  statusId?: string;
}

export function useCrmConnection(wsId: string | null) {
  return useQuery({
    queryKey: [...crmKey(wsId), 'connection'],
    queryFn: () => api.get<CrmConnection | null>(`/workspaces/${wsId}/crm/connection`),
    enabled: !!wsId,
  });
}

export function useCrmSummary(wsId: string | null) {
  return useQuery({
    queryKey: [...crmKey(wsId), 'summary'],
    queryFn: () => api.get<CrmSummary>(`/workspaces/${wsId}/crm/deals/summary`),
    enabled: !!wsId,
  });
}

export function useCrmDeals(wsId: string | null, filters: CrmDealsFilters) {
  return useInfiniteQuery({
    queryKey: [...crmKey(wsId), 'deals', filters.tab, filters.search ?? '', filters.statusId ?? ''],
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ tab: filters.tab, limit: '50' });
      if (filters.search) p.set('search', filters.search);
      if (filters.statusId) p.set('statusId', filters.statusId);
      if (pageParam) p.set('cursor', pageParam);
      return api.get<CrmDealsPage>(`/workspaces/${wsId}/crm/deals?${p.toString()}`);
    },
    initialPageParam: '' as string,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: !!wsId,
  });
}

/** Живые воронки из amo — только когда открыто окно настроек. */
export function useCrmPipelines(wsId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: [...crmKey(wsId), 'pipelines'],
    queryFn: () => api.get<CrmPipeline[]>(`/workspaces/${wsId}/crm/connection/pipelines`),
    enabled: !!wsId && enabled,
    staleTime: 60_000,
  });
}

export interface ConnectCrmInput {
  subdomain: string;
  token: string;
  pipelineId?: number;
  triggerStatusId?: number;
}

export interface UpdateCrmInput {
  token?: string;
  status?: 'ACTIVE' | 'DISABLED';
  pipelineId?: number | null;
  triggerStatusId?: number | null;
}

/**
 * Инвалидация НЕ возвращает промис намеренно: TanStack ждёт хук-уровневый
 * onSuccess до вызова колбэков mutate(). Если за это время перечитанное
 * подключение сменило ветку экрана и размонтировало окно, его колбэки
 * (тост, закрытие, «открыть настройки») не вызываются вовсе — так на проде
 * после «Подключить» не открылось окно настроек. Поэтому перечитываем в фоне.
 */
function useInvalidateCrm(wsId: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: crmKey(wsId) });
  };
}

export function useConnectCrm(wsId: string) {
  const invalidate = useInvalidateCrm(wsId);
  return useMutation({
    mutationFn: (input: ConnectCrmInput) =>
      api.post<CrmConnection>(`/workspaces/${wsId}/crm/connection`, input),
    onSuccess: invalidate,
  });
}

export function useUpdateCrmConnection(wsId: string) {
  const invalidate = useInvalidateCrm(wsId);
  return useMutation({
    mutationFn: (input: UpdateCrmInput) =>
      api.patch<CrmConnection>(`/workspaces/${wsId}/crm/connection`, input),
    onSuccess: invalidate,
  });
}

export function useDisconnectCrm(wsId: string) {
  const invalidate = useInvalidateCrm(wsId);
  return useMutation({
    mutationFn: () => api.del(`/workspaces/${wsId}/crm/connection`),
    onSuccess: invalidate,
  });
}

export function useSyncCrm(wsId: string) {
  const invalidate = useInvalidateCrm(wsId);
  return useMutation({
    mutationFn: () => api.post<CrmSyncResult>(`/workspaces/${wsId}/crm/connection/sync`),
    // Синк мог упасть и перевести подключение в ERROR — статус тоже надо перечитать.
    onSettled: invalidate,
  });
}

/** После связи со сделкой у заказа появляется ссылка на amo — списки заказов тоже устаревают. */
function useInvalidateCrmAndOrders(wsId: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: crmKey(wsId) });
    void qc.invalidateQueries({ queryKey: ['orders', wsId] });
    void qc.invalidateQueries({ queryKey: ['order', wsId] });
    void qc.invalidateQueries({ queryKey: ['counterparties', wsId] });
  };
}

export function useLinkCrmDeal(wsId: string) {
  const invalidate = useInvalidateCrmAndOrders(wsId);
  return useMutation({
    mutationFn: ({ dealId, orderId }: { dealId: string; orderId: string }) =>
      api.post<CrmDeal>(`/workspaces/${wsId}/crm/deals/${dealId}/link`, { orderId }),
    onSuccess: invalidate,
  });
}

export function useUnlinkCrmDeal(wsId: string) {
  const invalidate = useInvalidateCrmAndOrders(wsId);
  return useMutation({
    mutationFn: (dealId: string) =>
      api.post<CrmDeal>(`/workspaces/${wsId}/crm/deals/${dealId}/unlink`),
    onSuccess: invalidate,
  });
}

export function useDismissCrmDeal(wsId: string) {
  const invalidate = useInvalidateCrm(wsId);
  return useMutation({
    mutationFn: ({ dealId, dismissed }: { dealId: string; dismissed: boolean }) =>
      api.post<CrmDeal>(
        `/workspaces/${wsId}/crm/deals/${dealId}/${dismissed ? 'dismiss' : 'undismiss'}`,
      ),
    onSuccess: invalidate,
  });
}

export interface CreateOrderFromDealResult {
  orderId: string;
  orderNumber: string;
  deal: CrmDeal;
}

export function useCreateOrderFromDeal(wsId: string) {
  const invalidate = useInvalidateCrmAndOrders(wsId);
  return useMutation({
    mutationFn: (dealId: string) =>
      api.post<CreateOrderFromDealResult>(`/workspaces/${wsId}/crm/deals/${dealId}/create-order`),
    onSuccess: invalidate,
  });
}
