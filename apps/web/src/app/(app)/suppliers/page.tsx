'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Truck, Search, X, Trash2, Pencil } from '@/components/ui/icons';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import {
  useCounterparties,
  useCreateCounterparty,
  useUpdateCounterparty,
  useDeleteCounterparty,
} from '@/hooks/useCounterparties';
import type { Counterparty } from '@/lib/types';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { FormField } from '@/components/ui/FormField';
import { FilterBar } from '@/components/ui/FilterBar';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/Sheet';

export default function SuppliersPage() {
  const router = useRouter();
  const { current } = useCurrentWorkspace();
  const wsId = current?.id ?? null;
  const [search, setSearch] = useState('');
  // В инпуте — сырой search, в запрос уходит значение после паузы в наборе.
  const debouncedSearch = useDebouncedValue(search);
  const list = useCounterparties(wsId, debouncedSearch || undefined, false, 'SUPPLIER');
  const [editing, setEditing] = useState<Counterparty | null>(null);
  const [creating, setCreating] = useState(false);

  if (!current) {
    return (
      <>
        <PageHeader title="Поставщики" />
        <div className="p-6">
          <EmptyState icon={Truck} title="Нет активного пространства" hint="Выберите или создайте пространство." />
        </div>
      </>
    );
  }

  const columns: Column<Counterparty>[] = [
    {
      key: 'name',
      header: 'Название',
      cell: (c) => (
        <div className="min-w-0">
          <div className="truncate font-medium">{c.name}</div>
          {c.contact && <div className="truncate text-xs text-muted-foreground">{c.contact}</div>}
        </div>
      ),
    },
    {
      key: 'inn',
      header: 'ИНН',
      cell: (c) => <span className="tabular-nums text-muted-foreground">{c.inn ?? '—'}</span>,
      className: 'w-[160px]',
    },
    {
      key: 'note',
      header: 'Примечание',
      cell: (c) => <span className="line-clamp-1 text-muted-foreground">{c.note ?? '—'}</span>,
    },
    {
      key: 'status',
      header: 'Статус',
      cell: (c) => (c.isArchived ? <Badge variant="muted">В архиве</Badge> : <Badge variant="outline">Активен</Badge>),
      className: 'w-[120px]',
    },
    {
      // Клик по строке ведёт на карточку — редактирование на кнопке-карандаше.
      key: 'actions',
      header: '',
      align: 'right',
      cell: (c) => (
        <Button
          variant="ghost"
          size="icon"
          onClick={(e) => {
            e.stopPropagation();
            setEditing(c);
          }}
          aria-label="Редактировать поставщика"
          title="Редактировать"
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
      ),
      className: 'w-[60px]',
    },
  ];

  return (
    <>
      <PageHeader
        title="Поставщики"
        breadcrumbs={[{ label: 'Справочники' }, { label: 'Поставщики' }]}
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> Добавить
          </Button>
        }
      />
      <FilterBar>
        <div className="min-w-[240px] max-w-md flex-1">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Поиск по названию или ИНН"
              className="h-9 pl-8"
            />
          </div>
        </div>
      </FilterBar>
      <div className="bg-card">
        <DataTable
          data={list.data ?? []}
          columns={columns}
          rowKey={(c) => c.id}
          onRowClick={(c) => router.push(`/suppliers/${c.id}` as Parameters<typeof router.push>[0])}
          loading={list.isLoading}
          error={list.error}
          onRetry={() => list.refetch()}
          empty={
            <EmptyState
              icon={Truck}
              title="Пока нет поставщиков"
              hint="Добавьте поставщика, чтобы привязывать к нему закупки на склад."
              action={
                <Button onClick={() => setCreating(true)}>
                  <Plus className="h-4 w-4" /> Добавить
                </Button>
              }
            />
          }
          mobileCards={(c) => (
            <div className="flex items-start justify-between gap-2">
              <div className="flex min-w-0 flex-col gap-0.5">
                <div className="truncate font-medium">{c.name}</div>
                {c.inn && <div className="truncate text-xs text-muted-foreground">ИНН {c.inn}</div>}
                {c.contact && <div className="truncate text-xs text-muted-foreground">{c.contact}</div>}
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={(e) => {
                  e.stopPropagation();
                  setEditing(c);
                }}
                aria-label="Редактировать поставщика"
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
        />
      </div>
      <SupplierForm
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

function SupplierForm({
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
  const [inn, setInn] = useState('');
  const [note, setNote] = useState('');
  const [isArchived, setIsArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);

  useEffect(() => {
    if (initial) {
      setName(initial.name);
      setContact(initial.contact ?? '');
      setInn(initial.inn ?? '');
      setNote(initial.note ?? '');
      setIsArchived(initial.isArchived);
    } else {
      setName('');
      setContact('');
      setInn('');
      setNote('');
      setIsArchived(false);
    }
    setError(null);
  }, [initial, open]);

  const onSave = async () => {
    setError(null);
    try {
      if (initial) {
        await update.mutateAsync({
          id: initial.id,
          name: name.trim(),
          role: 'SUPPLIER',
          contact: contact.trim() || null,
          inn: inn.trim() || null,
          note: note.trim() || null,
          isArchived,
        });
      } else {
        await create.mutateAsync({
          name: name.trim(),
          role: 'SUPPLIER',
          contact: contact.trim() || undefined,
          inn: inn.trim() || undefined,
          note: note.trim() || undefined,
        });
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
        <SheetContent side="right" hideClose>
          <SheetHeader className="flex-row items-center justify-between gap-2 space-y-0">
            <SheetTitle>{initial ? 'Редактировать поставщика' : 'Новый поставщик'}</SheetTitle>
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="Закрыть">
              <X className="h-4 w-4" />
            </Button>
          </SheetHeader>
          <form
            className="flex min-h-0 flex-1 flex-col"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void onSave();
            }}
          >
          <SheetBody className="space-y-4">
            <FormField label="Название" htmlFor="s-name" required>
              <Input id="s-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            </FormField>
            <FormField label="Контакт" htmlFor="s-contact">
              <Input
                id="s-contact"
                value={contact}
                onChange={(e) => setContact(e.target.value)}
                placeholder="телефон, email, менеджер"
              />
            </FormField>
            <FormField label="ИНН" htmlFor="s-inn">
              <Input id="s-inn" value={inn} onChange={(e) => setInn(e.target.value)} inputMode="numeric" />
            </FormField>
            <FormField label="Примечание" htmlFor="s-note">
              <Textarea id="s-note" value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
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
                type="button"
                variant="destructive"
                onClick={() => setConfirmDel(true)}
                className="sm:mr-auto"
              >
                <Trash2 className="h-3.5 w-3.5" /> Удалить
              </Button>
            )}
            <Button type="button" variant="secondary" onClick={onClose}>
              Отмена
            </Button>
            <Button
              type="submit"
              loading={create.isPending || update.isPending}
              disabled={!name.trim()}
            >
              Сохранить
            </Button>
          </SheetFooter>
          </form>
        </SheetContent>
      </Sheet>
      <ConfirmDialog
        open={confirmDel}
        onOpenChange={setConfirmDel}
        title={`Удалить «${initial?.name ?? ''}»?`}
        description="Поставщик переместится в архив, его закупки сохранятся."
        confirmText="Удалить"
        onConfirm={onDelete}
        loading={del.isPending}
      />
    </>
  );
}
