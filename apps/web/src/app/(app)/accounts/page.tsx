'use client';

import { useEffect, useState } from 'react';
import { Plus, Wallet, X, Trash2 } from '@/components/ui/icons';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import {
  useAccounts,
  useCreateAccount,
  useUpdateAccount,
  useDeleteAccount,
  type CreateAccountInput,
} from '@/hooks/useAccounts';
import type { Account, AccountType } from '@/lib/types';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { FormField } from '@/components/ui/FormField';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/Sheet';
import { formatRub } from '@construct/shared';

const TYPE_LABELS: Record<AccountType, string> = {
  CASH: 'Наличные',
  BANK: 'Банк',
  OTHER: 'Другое',
};

export default function AccountsPage() {
  const { current } = useCurrentWorkspace();
  const wsId = current?.id ?? null;
  const accounts = useAccounts(wsId);
  const [editing, setEditing] = useState<Account | null>(null);
  const [creating, setCreating] = useState(false);

  if (!current) {
    return (
      <>
        <PageHeader title="Счета" />
        <div className="p-6">
          <EmptyState
            icon={Wallet}
            title="Нет активного пространства"
            hint="Выберите или создайте пространство."
          />
        </div>
      </>
    );
  }

  const columns: Column<Account>[] = [
    {
      key: 'name',
      header: 'Название',
      sortable: true,
      cell: (a) => (
        <div className="min-w-0">
          <div className="truncate font-medium text-foreground">{a.name}</div>
          {a.note && (
            <div className="truncate text-xs text-muted-foreground">{a.note}</div>
          )}
        </div>
      ),
    },
    {
      key: 'type',
      header: 'Тип',
      cell: (a) => <span className="text-muted-foreground">{TYPE_LABELS[a.type]}</span>,
      className: 'w-[140px]',
    },
    {
      key: 'status',
      header: 'Статус',
      cell: (a) =>
        a.isArchived ? (
          <Badge variant="muted">В архиве</Badge>
        ) : (
          <Badge variant="outline">Активен</Badge>
        ),
      className: 'w-[120px]',
    },
    {
      key: 'opening',
      header: 'Начальный остаток',
      align: 'right',
      sortable: true,
      cell: (a) => formatRub(a.openingBalance),
      className: 'w-[180px]',
    },
  ];

  return (
    <>
      <PageHeader
        title="Счета"
        breadcrumbs={[{ label: 'Справочники' }, { label: 'Счета' }]}
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" />
            Добавить
          </Button>
        }
      />
      <div className="bg-card border-t border-border">
        <DataTable
          data={accounts.data ?? []}
          columns={columns}
          rowKey={(a) => a.id}
          onRowClick={(a) => setEditing(a)}
          loading={accounts.isLoading}
          empty={
            <EmptyState
              icon={Wallet}
              title="Пока нет счетов"
              hint="Добавьте первый счёт — наличку, карту или счёт в банке."
              action={
                <Button onClick={() => setCreating(true)}>
                  <Plus className="h-4 w-4" /> Добавить счёт
                </Button>
              }
            />
          }
          mobileCards={(a) => (
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate font-medium">{a.name}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {TYPE_LABELS[a.type]}
                  {a.isArchived && ' · в архиве'}
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className="text-[10px] uppercase text-muted-foreground">Остаток</div>
                <div className="text-sm font-medium tabular-nums">
                  {formatRub(a.openingBalance)}
                </div>
              </div>
            </div>
          )}
        />
      </div>

      <AccountForm
        wsId={current.id}
        open={creating || !!editing}
        initial={editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
      />
    </>
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
  const [confirmDel, setConfirmDel] = useState(false);

  const [name, setName] = useState(initial?.name ?? '');
  const [type, setType] = useState<AccountType>(initial?.type ?? 'BANK');
  const [openingBalance, setOpeningBalance] = useState(initial?.openingBalance ?? '0');
  const [note, setNote] = useState(initial?.note ?? '');
  const [isArchived, setIsArchived] = useState(initial?.isArchived ?? false);

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
    setError(null);
  }, [initial, open]);

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
    await del.mutateAsync(initial.id);
    onClose();
  };

  return (
    <>
      <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
        <SheetContent side="right" hideClose className="sm:max-w-md">
          <SheetHeader className="flex-row items-center justify-between gap-2 space-y-0">
            <SheetTitle>{initial ? 'Редактировать счёт' : 'Новый счёт'}</SheetTitle>
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="Закрыть">
              <X className="h-4 w-4" />
            </Button>
          </SheetHeader>
          <SheetBody className="space-y-4">
            <FormField label="Название" htmlFor="acc-name" required>
              <Input
                id="acc-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Альфа-Банк ИП"
                autoFocus
              />
            </FormField>
            <FormField label="Тип" htmlFor="acc-type">
              <Select
                id="acc-type"
                value={type}
                onChange={(e) => setType(e.target.value as AccountType)}
              >
                <option value="CASH">Наличные</option>
                <option value="BANK">Банк</option>
                <option value="OTHER">Другое</option>
              </Select>
            </FormField>
            <FormField label="Начальный остаток" htmlFor="acc-opening">
              <Input
                id="acc-opening"
                inputMode="decimal"
                value={openingBalance}
                onChange={(e) => setOpeningBalance(e.target.value)}
                placeholder="0.00"
              />
            </FormField>
            <FormField label="Примечание" htmlFor="acc-note">
              <Input
                id="acc-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="опционально"
              />
            </FormField>
            {initial && (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={isArchived}
                  onChange={(e) => setIsArchived(e.target.checked)}
                  className="h-4 w-4 rounded border-input accent-primary"
                />
                В архиве
              </label>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
          </SheetBody>
          <SheetFooter>
            {initial && (
              <Button
                variant="destructive"
                onClick={() => setConfirmDel(true)}
                className="sm:mr-auto"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Удалить
              </Button>
            )}
            <Button variant="secondary" onClick={onClose}>
              Отмена
            </Button>
            <Button
              onClick={onSave}
              disabled={!name.trim() || create.isPending || update.isPending}
            >
              {(create.isPending || update.isPending) ? 'Сохраняю…' : 'Сохранить'}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
      <ConfirmDialog
        open={confirmDel}
        onOpenChange={setConfirmDel}
        title={`Удалить «${initial?.name ?? ''}»?`}
        description="Счёт переместится в архив, операции по нему останутся."
        confirmText="Удалить"
        onConfirm={onDelete}
        loading={del.isPending}
      />
    </>
  );
}
