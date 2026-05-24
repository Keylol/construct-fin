'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { RecurringFrequency, RecurringRule, RecurringTemplate } from '@/lib/types';

export interface CreateRecurringInput {
  name: string;
  template: RecurringTemplate;
  frequency: RecurringFrequency;
  interval: number;
  startDate: string;
  endDate?: string | null;
  dayOfMonth?: number | null;
  dayOfWeek?: number | null;
  active?: boolean;
}

export type UpdateRecurringInput = Partial<CreateRecurringInput>;

export function useRecurringRules(wsId: string | null) {
  return useQuery({
    queryKey: ['recurring', wsId],
    queryFn: () => api.get<RecurringRule[]>(`/workspaces/${wsId}/recurring`),
    enabled: !!wsId,
  });
}

export function useCreateRecurringRule(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRecurringInput) =>
      api.post<RecurringRule>(`/workspaces/${wsId}/recurring`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['recurring', wsId] }),
  });
}

export function useUpdateRecurringRule(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateRecurringInput & { id: string }) =>
      api.patch<RecurringRule>(`/workspaces/${wsId}/recurring/${id}`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['recurring', wsId] }),
  });
}

export function useDeleteRecurringRule(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/workspaces/${wsId}/recurring/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['recurring', wsId] }),
  });
}

export function useRunRecurringNow(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ created: number; skipped: number }>(
        `/workspaces/${wsId}/recurring/${id}/run-now`,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['recurring', wsId] });
      qc.invalidateQueries({ queryKey: ['transactions', wsId] });
      qc.invalidateQueries({ queryKey: ['transactions-summary', wsId] });
    },
  });
}
