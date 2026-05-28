'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface AuditEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  diff: unknown;
  createdAt: string;
  actor: { id: string; name: string } | null;
}

export interface AuditPage {
  items: AuditEntry[];
  nextCursor: string | null;
}

export function useAuditLog(wsId: string | null, limit = 100) {
  return useQuery({
    queryKey: ['audit', wsId, limit],
    queryFn: () => api.get<AuditPage>(`/workspaces/${wsId}/audit?limit=${limit}`),
    enabled: !!wsId,
  });
}
