'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type {
  CreatePlannedInput,
  CreateRecurringInput,
  PayPlannedInput,
  PlannedPayment,
  PlannedStatus,
  RecurringPayment,
  UpcomingPayments,
} from '@/lib/types';

const planningKey = (wsId: string | null) => ['planning', wsId];

export function useRecurring(wsId: string | null) {
  return useQuery({
    queryKey: [...planningKey(wsId), 'recurring'],
    queryFn: () => api.get<RecurringPayment[]>(`/workspaces/${wsId}/planning/recurring`),
    enabled: !!wsId,
  });
}

export function useUpcoming(wsId: string | null, horizonDays = 30) {
  return useQuery({
    queryKey: [...planningKey(wsId), 'upcoming', horizonDays],
    queryFn: () =>
      api.get<UpcomingPayments>(`/workspaces/${wsId}/planning/upcoming?horizonDays=${horizonDays}`),
    enabled: !!wsId,
  });
}

export function usePlannedList(
  wsId: string | null,
  filter: { status?: PlannedStatus; source?: string; counterpartyId?: string } = {},
) {
  return useQuery({
    queryKey: [...planningKey(wsId), 'planned', filter],
    queryFn: () => {
      const p = new URLSearchParams();
      if (filter.status) p.set('status', filter.status);
      if (filter.source) p.set('source', filter.source);
      if (filter.counterpartyId) p.set('counterpartyId', filter.counterpartyId);
      const qs = p.toString();
      return api.get<PlannedPayment[]>(`/workspaces/${wsId}/planning/planned${qs ? `?${qs}` : ''}`);
    },
    enabled: !!wsId,
  });
}

/** Счётчик «горящих» платежей для бейджа навигации (просрочка + скоро). */
export function usePlanningCount(wsId: string | null) {
  return useQuery({
    queryKey: [...planningKey(wsId), 'count'],
    queryFn: () => api.get<{ count: number }>(`/workspaces/${wsId}/planning/count`),
    enabled: !!wsId,
    refetchInterval: 60_000,
  });
}

/** Оплата плана создаёт проводку → устаревают касса, отчёты, налог. */
function invalidatePlanning(qc: ReturnType<typeof useQueryClient>, wsId: string) {
  qc.invalidateQueries({ queryKey: planningKey(wsId) });
  qc.invalidateQueries({ queryKey: ['transactions', wsId] });
  qc.invalidateQueries({ queryKey: ['transactions-infinite', wsId] });
  qc.invalidateQueries({ queryKey: ['transactions-summary', wsId] });
  qc.invalidateQueries({ queryKey: ['accounts', wsId] });
  qc.invalidateQueries({ queryKey: ['reports'] });
  qc.invalidateQueries({ queryKey: ['tax', wsId] });
}

function usePlanningMutation<TArgs>(wsId: string, fn: (args: TArgs) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => invalidatePlanning(qc, wsId),
  });
}

// ── Регулярка ──
export function useCreateRecurring(wsId: string) {
  return usePlanningMutation(wsId, (input: CreateRecurringInput) =>
    api.post(`/workspaces/${wsId}/planning/recurring`, input),
  );
}
export function useUpdateRecurring(wsId: string) {
  return usePlanningMutation(wsId, ({ id, ...input }: { id: string } & Partial<CreateRecurringInput>) =>
    api.patch(`/workspaces/${wsId}/planning/recurring/${id}`, input),
  );
}
export function useDeleteRecurring(wsId: string) {
  return usePlanningMutation(wsId, (id: string) =>
    api.del(`/workspaces/${wsId}/planning/recurring/${id}`),
  );
}

// ── Плановые платежи ──
export function useCreatePlanned(wsId: string) {
  return usePlanningMutation(wsId, (input: CreatePlannedInput) =>
    api.post(`/workspaces/${wsId}/planning/planned`, input),
  );
}
export function useUpdatePlanned(wsId: string) {
  return usePlanningMutation(wsId, ({ id, ...input }: { id: string } & Partial<CreatePlannedInput>) =>
    api.patch(`/workspaces/${wsId}/planning/planned/${id}`, input),
  );
}
export function useDeletePlanned(wsId: string) {
  return usePlanningMutation(wsId, (id: string) =>
    api.del(`/workspaces/${wsId}/planning/planned/${id}`),
  );
}
export function useSetPlannedStatus(wsId: string) {
  return usePlanningMutation(wsId, ({ id, status }: { id: string; status: 'PLANNED' | 'SKIPPED' | 'CANCELLED' }) =>
    api.post(`/workspaces/${wsId}/planning/planned/${id}/status`, { status }),
  );
}
export function usePayPlanned(wsId: string) {
  return usePlanningMutation(wsId, ({ id, ...input }: { id: string } & PayPlannedInput) =>
    api.post(`/workspaces/${wsId}/planning/planned/${id}/pay`, input),
  );
}
export function useRevertPlanned(wsId: string) {
  return usePlanningMutation(wsId, (id: string) =>
    api.post(`/workspaces/${wsId}/planning/planned/${id}/revert`, {}),
  );
}
