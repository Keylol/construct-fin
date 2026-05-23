'use client';

import { useEffect, useState } from 'react';
import { useWorkspaces } from './useWorkspaces';

const STORAGE_KEY = 'construct.currentWorkspaceId';

export function useCurrentWorkspace() {
  const workspaces = useWorkspaces();
  const [currentId, setCurrentId] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaces.data) return;
    const saved = typeof window !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    if (saved && workspaces.data.some((w) => w.id === saved)) {
      setCurrentId(saved);
    } else {
      const first = workspaces.data[0];
      setCurrentId(first ? first.id : null);
    }
  }, [workspaces.data]);

  const select = (id: string) => {
    setCurrentId(id);
    if (typeof window !== 'undefined') localStorage.setItem(STORAGE_KEY, id);
  };

  const current = workspaces.data?.find((w) => w.id === currentId) ?? null;

  return { current, currentId, workspaces, select };
}
