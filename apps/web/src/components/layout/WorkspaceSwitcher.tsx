'use client';

import { useState } from 'react';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useCreateWorkspace } from '@/hooks/useWorkspaces';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Label } from '@/components/ui/Label';

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
      <div className="flex flex-col gap-1">
        <Label className="!mb-0 !text-xs uppercase tracking-wide">Пространство</Label>
        {workspaces.data && workspaces.data.length > 0 ? (
          <select
            className="h-10 px-3 rounded-xl bg-surface text-fg border border-white/10 outline-none focus:border-tint focus:ring-2 focus:ring-tint/30"
            value={currentId ?? ''}
            onChange={(e) => select(e.target.value)}
          >
            {workspaces.data.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        ) : (
          <div className="text-muted text-sm">Нет пространств</div>
        )}
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-tint text-sm text-left mt-1 hover:underline"
        >
          + Создать пространство
        </button>
      </div>

      <Modal open={open} onClose={() => setOpen(false)} title="Новое пространство">
        <Label htmlFor="ws-name">Название</Label>
        <Input
          id="ws-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Напр. «ИП Каменский»"
          autoFocus
        />
        {error && <p className="text-danger text-sm mt-2">{error}</p>}
        <div className="flex gap-2 mt-5">
          <Button variant="secondary" onClick={() => setOpen(false)} className="flex-1">
            Отмена
          </Button>
          <Button
            onClick={onCreate}
            disabled={!name.trim() || create.isPending}
            className="flex-1"
          >
            {create.isPending ? 'Создаю…' : 'Создать'}
          </Button>
        </div>
      </Modal>

      {!current && workspaces.isSuccess && (workspaces.data?.length ?? 0) === 0 && (
        <p className="text-xs text-muted mt-2">
          Создайте первое пространство, чтобы начать.
        </p>
      )}
    </>
  );
}
