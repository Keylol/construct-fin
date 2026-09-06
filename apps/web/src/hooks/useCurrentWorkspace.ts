'use client';

import { useCallback, useState } from 'react';
import { useWorkspaces } from './useWorkspaces';
import { readStored, writeStored } from '@/lib/storage';

const STORAGE_KEY = 'construct.currentWorkspaceId';

/**
 * Текущее пространство: выбранное человеком, иначе сохранённое, иначе первое.
 *
 * Выводится из данных синхронно, а не через useEffect: раньше между приходом
 * списка и установкой id проходил один рендер с `current = null`, и каждый
 * экран на этот кадр показывал «Нет активного пространства». Сохранённый id
 * читается лениво и только в браузере — на сервере списка всё равно нет, так
 * что гидратация не расходится.
 */
export function useCurrentWorkspace() {
  const workspaces = useWorkspaces();
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    typeof window === 'undefined' ? null : readStored(STORAGE_KEY),
  );

  const list = workspaces.data;
  const current =
    (selectedId ? list?.find((w) => w.id === selectedId) : undefined) ?? list?.[0] ?? null;
  const currentId = current?.id ?? null;

  const select = useCallback((id: string) => {
    setSelectedId(id);
    writeStored(STORAGE_KEY, id);
  }, []);

  return { current, currentId, workspaces, select };
}
