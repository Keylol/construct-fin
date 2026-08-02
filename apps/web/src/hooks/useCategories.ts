'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Category, CategoryBucket, CategoryKind, CategoryTreeNode } from '@/lib/types';

export interface CreateCategoryInput {
  name: string;
  kind: CategoryKind;
  bucket?: CategoryBucket;
  parentId?: string | null;
  isFixedCost?: boolean;
}

export interface UpdateCategoryInput {
  name?: string;
  bucket?: CategoryBucket;
  parentId?: string | null;
  isFixedCost?: boolean;
  isArchived?: boolean;
}

export function useCategories(wsId: string | null, kind?: CategoryKind, includeArchived = false) {
  return useQuery({
    queryKey: ['categories', wsId, { kind, includeArchived }],
    queryFn: () => {
      const params = new URLSearchParams();
      if (kind) params.set('kind', kind);
      if (includeArchived) params.set('includeArchived', 'true');
      return api.get<Category[]>(`/workspaces/${wsId}/categories?${params.toString()}`);
    },
    enabled: !!wsId,
  });
}

export function useCategoryTree(wsId: string | null, kind?: CategoryKind) {
  return useQuery({
    queryKey: ['categories', wsId, 'tree', { kind }],
    queryFn: () => {
      const params = new URLSearchParams();
      if (kind) params.set('kind', kind);
      return api.get<CategoryTreeNode[]>(`/workspaces/${wsId}/categories/tree?${params.toString()}`);
    },
    enabled: !!wsId,
  });
}

export function useCreateCategory(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCategoryInput) =>
      api.post<Category>(`/workspaces/${wsId}/categories`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['categories', wsId] }),
  });
}

export function useUpdateCategory(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateCategoryInput & { id: string }) =>
      api.patch<Category>(`/workspaces/${wsId}/categories/${id}`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['categories', wsId] }),
  });
}

export function useDeleteCategory(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/workspaces/${wsId}/categories/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['categories', wsId] }),
  });
}
