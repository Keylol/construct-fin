'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type {
  ApplyRulesResult,
  BankLineStatus,
  InboxPage,
  TransferCandidate,
  PlannedLineSuggestion,
} from '@/lib/types';

/** Ключ, инвалидируемый после любого действия разбора и после синка. */
const inboxKey = (wsId: string | null) => ['inbox', wsId];

/** Поиск и фильтры списка. Пустые поля в запрос не уходят. */
export interface InboxFilters {
  /** Сумма, назначение, контрагент или ИНН. */
  q?: string;
  direction?: 'INCOME' | 'EXPENSE';
  accountId?: string;
}

/**
 * Строки выписки выбранного статуса. Постранично: после перезалива истории строк
 * бывает больше сотни, а одной страницей хвост просто не виден.
 *
 * Фильтры входят в ключ запроса — иначе при смене поиска показывался бы кэш
 * прежней выборки.
 */
export function useInbox(
  wsId: string | null,
  status: BankLineStatus = 'NEW',
  filters: InboxFilters = {},
) {
  const params = new URLSearchParams({ limit: '100', status });
  if (filters.q) params.set('q', filters.q);
  if (filters.direction) params.set('direction', filters.direction);
  if (filters.accountId) params.set('accountId', filters.accountId);
  const qs = params.toString();

  return useInfiniteQuery({
    queryKey: [...inboxKey(wsId), 'list', status, filters.q ?? '', filters.direction ?? '', filters.accountId ?? ''],
    queryFn: ({ pageParam }) =>
      api.get<InboxPage>(
        `/workspaces/${wsId}/inbox?${qs}` + (pageParam ? `&cursor=${pageParam}` : ''),
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
      // Разбор создаёт/снимает проводки, оплаты и гасит планы — освежаем всё зависимое.
      qc.invalidateQueries({ queryKey: ['transactions', wsId] });
      qc.invalidateQueries({ queryKey: ['orders', wsId] });
      qc.invalidateQueries({ queryKey: ['planning', wsId] });
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

/**
 * Привязка прихода к заказу. `installment` — кредит или рассрочка: банк присылает
 * сумму за вычетом своей комиссии, и без этого блока заказ остаётся
 * недоплаченным ровно на неё.
 */
export function useAttachOrderInbox(wsId: string) {
  return useInboxAction<{
    lineId: string;
    orderId: string;
    installment?: { amount: string; fee: string };
  }>(wsId, ({ lineId, ...body }) =>
    api.post(`/workspaces/${wsId}/inbox/${lineId}/attach-order`, body),
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

/**
 * Пары строк, похожие на две ноги одного перевода между своими счетами.
 * Без склейки такой перевод задваивает обороты: расход в одном банке и доход в
 * другом там, где деньги из бизнеса не выходили.
 */
export function useTransferCandidates(wsId: string | null) {
  return useQuery({
    queryKey: [...inboxKey(wsId), 'transfer-candidates'],
    queryFn: () =>
      api.get<{ items: TransferCandidate[] }>(
        `/workspaces/${wsId}/inbox/transfer-candidates`,
      ),
    enabled: !!wsId,
  });
}

/** Подтвердить пару → создаётся перевод, обе строки уходят из разбора. */
export function useConfirmTransfer(wsId: string) {
  return useInboxAction<{ outLineId: string; inLineId: string }>(wsId, (body) =>
    api.post<{ ok: true; transferId: string; fee: string }>(
      `/workspaces/${wsId}/inbox/confirm-transfer`,
      body,
    ),
  );
}

/** Перевод на счёт, выписку которого банк не отдаёт (карты физлиц). */
export function useMarkTransfer(wsId: string) {
  return useInboxAction<{ lineId: string; counterAccountId: string }>(
    wsId,
    ({ lineId, counterAccountId }) =>
      api.post(`/workspaces/${wsId}/inbox/${lineId}/mark-transfer`, { counterAccountId }),
  );
}

/** Строки, похожие на ожидаемые платежи, — подсказка гашения плана. */
export function usePlannedSuggestions(wsId: string | null) {
  return useQuery({
    queryKey: [...inboxKey(wsId), 'planned-suggestions'],
    queryFn: () =>
      api.get<{ items: PlannedLineSuggestion[] }>(
        `/workspaces/${wsId}/inbox/planned-suggestions`,
      ),
    enabled: !!wsId,
  });
}

/** Погасить план строкой: проводка с видом/категорией плана + закрытие плана. */
export function usePayPlannedFromLine(wsId: string) {
  return useInboxAction<{ lineId: string; plannedPaymentId: string }>(
    wsId,
    ({ lineId, plannedPaymentId }) =>
      api.post(`/workspaces/${wsId}/inbox/${lineId}/pay-planned`, { plannedPaymentId }),
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
