'use client';

import { useEffect, useState } from 'react';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import {
  useCounterparties,
  useCreateCounterparty,
  useUpdateCounterparty,
  useDeleteCounterparty,
} from '@/hooks/useCounterparties';
import type { Counterparty } from '@/lib/types';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { EmptyState } from '@/components/ui/EmptyState';

export default function CounterpartiesPage() {
  const { current } = useCurrentWorkspace();
  const wsId = current?.id ?? null;
  const [search, setSearch] = useState('');
  const list = useCounterparties(wsId, search || undefined);
  const [editing, setEditing] = useState<Counterparty | null>(null);
  const [creating, setCreating] = useState(false);

  if (!current) {
    return <EmptyState title="Нет активного пространства" hint="Выберите или создайте пространство." />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Контрагенты</h1>
        <Button size="sm" onClick={() => setCreating(true)}>+ Добавить</Button>
      </div>

      <Input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Поиск по имени или контакту"
      />

      {list.isLoading && <Card>Загрузка…</Card>}
      {list.error && <Card className="text-danger">Ошибка: {String(list.error)}</Card>}

      {list.data && list.data.length === 0 && (
        <EmptyState
          title="Пока нет контрагентов"
          hint="Добавьте клиента или поставщика, чтобы потом привязывать к ним операции."
          action={<Button onClick={() => setCreating(true)}>+ Добавить</Button>}
        />
      )}

      {list.data && list.data.length > 0 && (
        <div className="grid gap-3">
          {list.data.map((c) => (
            <Card
              key={c.id}
              className="cursor-pointer hover:bg-glass/80"
              onClick={() => setEditing(c)}
            >
              <div className="font-medium">{c.name}</div>
              {c.contact && <div className="text-sm text-muted">{c.contact}</div>}
              {c.note && <div className="text-xs text-muted mt-1 line-clamp-2">{c.note}</div>}
              {c.isArchived && <div className="text-xs text-muted mt-1">в архиве</div>}
            </Card>
          ))}
        </div>
      )}

      <CounterpartyForm
        wsId={current.id}
        open={creating || !!editing}
        initial={editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
      />
    </div>
  );
}

function CounterpartyForm({
  wsId,
  open,
  initial,
  onClose,
}: {
  wsId: string;
  open: boolean;
  initial: Counterparty | null;
  onClose: () => void;
}) {
  const create = useCreateCounterparty(wsId);
  const update = useUpdateCounterparty(wsId);
  const del = useDeleteCounterparty(wsId);
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [note, setNote] = useState('');
  const [isArchived, setIsArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initial) {
      setName(initial.name);
      setContact(initial.contact ?? '');
      setNote(initial.note ?? '');
      setIsArchived(initial.isArchived);
    } else {
      setName('');
      setContact('');
      setNote('');
      setIsArchived(false);
    }
    setError(null);
  }, [initial, open]);

  const onSave = async () => {
    setError(null);
    try {
      const input = {
        name: name.trim(),
        contact: contact.trim() || undefined,
        note: note.trim() || undefined,
      };
      if (initial) {
        await update.mutateAsync({
          id: initial.id,
          ...input,
          contact: input.contact ?? null,
          note: input.note ?? null,
          isArchived,
        });
      } else {
        await create.mutateAsync(input);
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    }
  };

  const onDelete = async () => {
    if (!initial) return;
    if (!confirm(`Удалить контрагента «${initial.name}»?`)) return;
    try {
      await del.mutateAsync(initial.id);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={initial ? 'Редактировать контрагента' : 'Новый контрагент'}>
      <div className="space-y-3">
        <div>
          <Label htmlFor="cp-name">Имя / название</Label>
          <Input id="cp-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </div>
        <div>
          <Label htmlFor="cp-contact">Контакт</Label>
          <Input id="cp-contact" value={contact} onChange={(e) => setContact(e.target.value)} placeholder="телефон, email, @username" />
        </div>
        <div>
          <Label htmlFor="cp-note">Заметка</Label>
          <textarea
            id="cp-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            className="w-full px-3 py-2 rounded-xl bg-surface text-fg border border-white/10 outline-none focus:border-tint focus:ring-2 focus:ring-tint/30 transition"
          />
        </div>
        {initial && (
          <label className="flex items-center gap-2 text-sm text-fg/80">
            <input type="checkbox" checked={isArchived} onChange={(e) => setIsArchived(e.target.checked)} />
            В архиве
          </label>
        )}
        {error && <p className="text-danger text-sm">{error}</p>}
        <div className="flex gap-2 pt-2">
          {initial && <Button variant="danger" onClick={onDelete} className="flex-1">Удалить</Button>}
          <Button variant="secondary" onClick={onClose} className="flex-1">Отмена</Button>
          <Button onClick={onSave} disabled={!name.trim()} className="flex-1">Сохранить</Button>
        </div>
      </div>
    </Modal>
  );
}
