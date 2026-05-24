'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { CategoryRule } from '@/lib/types';

export interface CreateCategoryRuleInput {
  keyword: string;
  categoryId: string;
  priority?: number;
  isActive?: boolean;
}
export type UpdateCategoryRuleInput = Partial<CreateCategoryRuleInput>;

export function useCategoryRules(wsId: string | null, includeInactive = false) {
  return useQuery({
    queryKey: ['category-rules', wsId, includeInactive],
    queryFn: () =>
      api.get<CategoryRule[]>(
        `/workspaces/${wsId}/category-rules${includeInactive ? '?includeInactive=true' : ''}`,
      ),
    enabled: !!wsId,
  });
}

export function useCreateCategoryRule(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCategoryRuleInput) =>
      api.post<CategoryRule>(`/workspaces/${wsId}/category-rules`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['category-rules', wsId] }),
  });
}

export function useUpdateCategoryRule(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateCategoryRuleInput & { id: string }) =>
      api.patch<CategoryRule>(`/workspaces/${wsId}/category-rules/${id}`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['category-rules', wsId] }),
  });
}

export function useDeleteCategoryRule(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<void>(`/workspaces/${wsId}/category-rules/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['category-rules', wsId] }),
  });
}
