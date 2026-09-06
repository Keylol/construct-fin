'use client';

import { useState } from 'react';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { Select } from '@/components/ui/Select';
import { CreateWorkspaceModal } from './CreateWorkspaceModal';

export function WorkspaceSwitcher() {
  const { current, currentId, workspaces, select } = useCurrentWorkspace();
  const [open, setOpen] = useState(false);

  return (
    <>
      <div className="space-y-1">
        <div className="px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Пространство
        </div>
        {workspaces.data && workspaces.data.length > 0 ? (
          <Select
            value={currentId ?? ''}
            onChange={(e) => select(e.target.value)}
            className="h-8 text-sm"
          >
            {workspaces.data.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
        ) : (
          <div className="px-1 text-sm text-muted-foreground">Нет пространств</div>
        )}
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="ml-1 text-xs text-primary transition-colors hover:underline"
        >
          + Создать
        </button>
      </div>

      <CreateWorkspaceModal open={open} onOpenChange={setOpen} onCreated={select} />

      {!current && workspaces.isSuccess && (workspaces.data?.length ?? 0) === 0 && (
        <p className="mt-2 px-1 text-xs text-muted-foreground">
          Создайте первое пространство, чтобы начать.
        </p>
      )}
    </>
  );
}
