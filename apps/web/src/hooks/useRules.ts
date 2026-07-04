'use client';

import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type {
  Rule,
  RuleAction,
  RuleAppliesTo,
  RuleCondition,
  RuleSuggestion,
} from '@/lib/types';

export interface CreateRuleInput {
  name: string;
  priority?: number;
  isActive?: boolean;
  appliesTo?: RuleAppliesTo;
  conditions: RuleCondition[];
  actions: RuleAction[];
}
export type UpdateRuleInput = Partial<CreateRuleInput>;

/** Контекст для подсказок — частично заполненная форма операции. */
export interface SuggestInput {
  description?: string | null;
  counterpartyId?: string | null;
  counterpartyName?: string | null;
  accountId?: string | null;
  amount?: string | null;
  type?: 'INCOME' | 'EXPENSE' | null;
  source: 'IMPORT' | 'MANUAL';
}

export function useRules(wsId: string | null) {
  return useQuery({
    queryKey: ['rules', wsId],
    queryFn: () => api.get<Rule[]>(`/workspaces/${wsId}/rules`),
    enabled: !!wsId,
  });
}

export function useCreateRule(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRuleInput) =>
      api.post<Rule>(`/workspaces/${wsId}/rules`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rules', wsId] }),
  });
}

export function useUpdateRule(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateRuleInput & { id: string }) =>
      api.patch<Rule>(`/workspaces/${wsId}/rules/${id}`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rules', wsId] }),
  });
}

export function useDeleteRule(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<void>(`/workspaces/${wsId}/rules/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rules', wsId] }),
  });
}

/**
 * Императивный запрос подсказок (не useQuery: дёргается по мере заполнения формы).
 * Возвращает функцию, безопасную к отсутствию wsId.
 */
export function useRuleSuggest(wsId: string | null) {
  return useCallback(
    (input: SuggestInput): Promise<RuleSuggestion> => {
      if (!wsId) return Promise.resolve({ matchedRuleIds: [] });
      return api.post<RuleSuggestion>(`/workspaces/${wsId}/rules/suggest`, input);
    },
    [wsId],
  );
}
