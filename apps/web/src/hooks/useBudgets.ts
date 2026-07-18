'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { BudgetReport } from '@/lib/types';

/** Бюджет план/факт по категориям: список за месяц + CRUD лимитов. */

const budgetsKey = (wsId: string | null) => ['budgets', wsId];

export function useBudgets(wsId: string | null, month?: string) {
  return useQuery({
    queryKey: [...budgetsKey(wsId), month ?? 'current'],
    queryFn: () =>
      api.get<BudgetReport>(
        `/workspaces/${wsId}/budgets${month ? `?month=${month}` : ''}`,
      ),
    enabled: !!wsId,
  });
}

function useBudgetMutation<TArgs>(wsId: string, fn: (args: TArgs) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => qc.invalidateQueries({ queryKey: budgetsKey(wsId) }),
  });
}

export interface CreateBudgetInput {
  categoryId: string;
  amount: string;
  note?: string | null;
}

export function useCreateBudget(wsId: string) {
  return useBudgetMutation(wsId, (input: CreateBudgetInput) =>
    api.post(`/workspaces/${wsId}/budgets`, input),
  );
}

export function useUpdateBudget(wsId: string) {
  return useBudgetMutation(
    wsId,
    ({ id, ...input }: { id: string; amount?: string; note?: string | null }) =>
      api.patch(`/workspaces/${wsId}/budgets/${id}`, input),
  );
}

export function useDeleteBudget(wsId: string) {
  return useBudgetMutation(wsId, (id: string) => api.del(`/workspaces/${wsId}/budgets/${id}`));
}
