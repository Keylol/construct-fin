'use client';

import { useEffect, useState } from 'react';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import {
  useAccounts,
  useCreateAccount,
  useUpdateAccount,
  useDeleteAccount,
  type CreateAccountInput,
} from '@/hooks/useAccounts';
import type { Account, AccountType } from '@/lib/types';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Label } from '@/components/ui/Label';
import { EmptyState } from '@/components/ui/EmptyState';
import { formatRub } from '@construct/shared';

const TYPE_LABELS: Record<AccountType, string> = {
  CASH: 'Наличные',
  BANK: 'Банк',
  CARD: 'Карта',
  OTHER: 'Другое',
};

export default function AccountsPage() {
  const { current } = useCurrentWorkspace();
  const wsId = current?.id ?? null;
  const accounts = useAccounts(wsId);
  const [editing, setEditing] = useState<Account | null>(null);
  const [creating, setCreating] = useState(false);

  if (!current) {
    return <EmptyState title="Нет активного пространства" hint="Выберите или создайте пространство." />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Счета</h1>
        <Button size="sm" onClick={() => setCreating(true)}>+ Добавить</Button>
      </div>

      {accounts.isLoading && <Card>Загрузка…</Card>}
      {accounts.error && <Card className="text-danger">Ошибка: {String(accounts.error)}</Card>}

      {accounts.data && accounts.data.length === 0 && (
        <EmptyState
          title="Пока нет счетов"
          hint="Добавьте первый счёт — это может быть наличка, карта или счёт в банке."
          action={<Button onClick={() => setCreating(true)}>+ Добавить счёт</Button>}
        />
      )}

      {accounts.data && accounts.data.length > 0 && (
        <div className="grid gap-3">
          {accounts.data.map((a) => (
            <Card
              key={a.id}
              className="flex items-center justify-between cursor-pointer hover:bg-glass/80"
              onClick={() => setEditing(a)}
            >
              <div>
                <div className="font-medium">{a.name}</div>
                <div className="text-xs text-muted">{TYPE_LABELS[a.type]}{a.isArchived ? ' · в архиве' : ''}</div>
              </div>
              <div className="text-right">
                <div className="text-sm text-muted">Начальный остаток</div>
                <div className="font-medium">{formatRub(a.openingBalance)}</div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <AccountForm
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

function AccountForm({
  wsId,
  open,
  initial,
  onClose,
}: {
  wsId: string;
  open: boolean;
  initial: Account | null;
  onClose: () => void;
}) {
  const create = useCreateAccount(wsId);
  const update = useUpdateAccount(wsId);
  const del = useDeleteAccount(wsId);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState(initial?.name ?? '');
  const [type, setType] = useState<AccountType>(initial?.type ?? 'BANK');
  const [openingBalance, setOpeningBalance] = useState(initial?.openingBalance ?? '0');
  const [note, setNote] = useState(initial?.note ?? '');
  const [isArchived, setIsArchived] = useState(initial?.isArchived ?? false);

  // sync when initial changes (открыли другую запись)
  useEffect(() => {
    if (initial) {
      setName(initial.name);
      setType(initial.type);
      setOpeningBalance(initial.openingBalance);
      setNote(initial.note ?? '');
      setIsArchived(initial.isArchived);
    } else {
      setName('');
      setType('BANK');
      setOpeningBalance('0');
      setNote('');
      setIsArchived(false);
    }
  }, [initial]);

  const onSave = async () => {
    setError(null);
    try {
      const input: CreateAccountInput = {
        name: name.trim(),
        type,
        openingBalance: openingBalance.replace(',', '.'),
        note: note.trim() || undefined,
      };
      if (initial) {
        await update.mutateAsync({ id: initial.id, ...input, isArchived });
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
    if (!confirm(`Удалить счёт «${initial.name}»? Это soft-delete, можно восстановить из БД.`)) return;
    try {
      await del.mutateAsync(initial.id);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={initial ? 'Редактировать счёт' : 'Новый счёт'}>
      <div className="space-y-3">
        <div>
          <Label htmlFor="acc-name">Название</Label>
          <Input id="acc-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Альфа-Банк ИП" autoFocus />
        </div>
        <div>
          <Label htmlFor="acc-type">Тип</Label>
          <Select id="acc-type" value={type} onChange={(e) => setType(e.target.value as AccountType)}>
            <option value="CASH">Наличные</option>
            <option value="BANK">Банк</option>
            <option value="CARD">Карта</option>
            <option value="OTHER">Другое</option>
          </Select>
        </div>
        <div>
          <Label htmlFor="acc-opening">Начальный остаток</Label>
          <Input
            id="acc-opening"
            inputMode="decimal"
            value={openingBalance}
            onChange={(e) => setOpeningBalance(e.target.value)}
            placeholder="0.00"
          />
        </div>
        <div>
          <Label htmlFor="acc-note">Заметка</Label>
          <Input id="acc-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="опционально" />
        </div>
        {initial && (
          <label className="flex items-center gap-2 text-sm text-fg/80">
            <input type="checkbox" checked={isArchived} onChange={(e) => setIsArchived(e.target.checked)} />
            В архиве
          </label>
        )}
        {error && <p className="text-danger text-sm">{error}</p>}
        <div className="flex gap-2 pt-2">
          {initial && (
            <Button variant="danger" onClick={onDelete} className="flex-1">Удалить</Button>
          )}
          <Button variant="secondary" onClick={onClose} className="flex-1">Отмена</Button>
          <Button onClick={onSave} disabled={!name.trim() || create.isPending || update.isPending} className="flex-1">
            Сохранить
          </Button>
        </div>
      </div>
    </Modal>
  );
}
