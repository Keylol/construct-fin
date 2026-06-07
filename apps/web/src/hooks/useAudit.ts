'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { AuditPage } from '@/lib/types';

const PAGE_SIZE = 100;

/** Журнал аудита workspace (Фаза 5 п.23). Курсор-пагинация: «Загрузить ещё». */
export function useAudit(wsId: string | null) {
  return useInfiniteQuery({
    queryKey: ['audit', wsId],
    enabled: !!wsId,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (pageParam) p.set('cursor', pageParam);
      return api.get<AuditPage>(`/workspaces/${wsId}/audit?${p.toString()}`);
    },
    getNextPageParam: (last) => last.nextCursor,
  });
}
