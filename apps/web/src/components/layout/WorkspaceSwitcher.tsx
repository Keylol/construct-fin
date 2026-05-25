'use client';

import { useState } from 'react';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useCreateWorkspace } from '@/hooks/useWorkspaces';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { FormField } from '@/components/ui/FormField';

export function WorkspaceSwitcher() {
  const { current, currentId, workspaces, select } = useCurrentWorkspace();
  const create = useCreateWorkspace();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const onCreate = async () => {
    setError(null);
    try {
      const ws = await create.mutateAsync({ name });
      select(ws.id);
      setName('');
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось создать');
    }
  };

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

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Новое пространство</DialogTitle>
          </DialogHeader>
          <FormField label="Название" htmlFor="ws-name" required>
            <Input
              id="ws-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Напр. «ИП Каменский»"
              autoFocus
            />
          </FormField>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Отмена
            </Button>
            <Button
              onClick={onCreate}
              disabled={!name.trim() || create.isPending}
            >
              {create.isPending ? 'Создаю…' : 'Создать'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {!current && workspaces.isSuccess && (workspaces.data?.length ?? 0) === 0 && (
        <p className="mt-2 px-1 text-xs text-muted-foreground">
          Создайте первое пространство, чтобы начать.
        </p>
      )}
    </>
  );
}
