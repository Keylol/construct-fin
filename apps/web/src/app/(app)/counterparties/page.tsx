'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { Plus, Users, X, Trash2, RotateCcw } from '@/components/ui/icons';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useListHotkeys } from '@/hooks/useListHotkeys';
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
import { SearchField } from '@/components/ui/SearchField';
import { FilterField } from '@/components/ui/FilterField';
import { Textarea } from '@/components/ui/Textarea';
import { StatusDot } from '@/components/ui/StatusDot';
import { EmptyState } from '@/components/ui/EmptyState';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { TileGrid, ViewToggle, useTileView } from '@/components/ui/Tile';
import { CounterpartyTile } from '@/components/counterparties/CounterpartyTile';
import { FormField } from '@/components/ui/FormField';
import { FilterBar } from '@/components/ui/FilterBar';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  ModalClose,
} from '@/components/ui/Modal';
import { useUrlFilters } from '@/hooks/useUrlFilters';
import { flatCodec } from '@/lib/url-codec';
import { Checkbox } from '@/components/ui/Checkbox';

const DEFAULTS = { q: '' };
const FILTERS = flatCodec(DEFAULTS);

// useSearchParams требует Suspense-границу на уровне page (Next 14 App Router).
export default function CounterpartiesPage() {
  return (
    <Suspense>
      <CounterpartiesView />
    </Suspense>
  );
}

function CounterpartiesView() {
  const { current } = useCurrentWorkspace();
  const wsId = current?.id ?? null;
  const [filters, setFilters] = useUrlFilters(FILTERS);
  // Вид: справочник обычно смотрят списком, плитки — когда следят за долгами.
  const [view, changeView] = useTileView('counterparties:view');
  // В инпуте — сырой search, в запрос уходит значение после паузы в наборе.
  const debouncedSearch = useDebouncedValue(filters.q);
  const list = useCounterparties(wsId, debouncedSearch || undefined);
  const [editing, setEditing] = useState<Counterparty | null>(null);
  const [creating, setCreating] = useState(false);
  // «/» — в поиск, «n» — создать: список листают с клавиатуры.
  const searchRef = useRef<HTMLInputElement>(null);
  useListHotkeys({ searchRef, onNew: () => setCreating(true) });

  if (!current) return null;

  const columns: Column<Counterparty>[] = [
    {
      key: 'name',
      header: 'Имя / название',
      cell: (c) => (
        <div className="min-w-0">
          <div className="truncate font-medium">{c.name}</div>
          {c.contact && (
            <div className="truncate text-xs text-muted-foreground">{c.contact}</div>
          )}
        </div>
      ),
    },
    {
      key: 'note',
      header: 'Примечание',
      cell: (c) => (
        <span className="line-clamp-1 text-muted-foreground">{c.note ?? '—'}</span>
      ),
    },
    {
      key: 'status',
      header: 'Статус',
      // №15: точка + текст вместо пилюли — статус как вторичный сигнал.
      cell: (c) => (
        <StatusDot
          tone={c.isArchived ? 'muted' : 'success'}
          label={c.isArchived ? 'В архиве' : 'Активен'}
        />
      ),
      className: 'w-[120px]',
    },
  ];

  return (
    <>
      <PageHeader
        title="Контрагенты"
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" />
            Добавить
          </Button>
        }
      />

      <FilterBar>
        <div className="min-w-[240px] max-w-md flex-1">
          <FilterField label="Поиск">
            <SearchField
              ref={searchRef}
              value={filters.q}
              onChange={(e) => setFilters({ ...filters, q: e.target.value })}
              placeholder="Поиск по имени или контакту"
            />
          </FilterField>
        </div>
        <ViewToggle view={view} onChange={changeView} />
        <Button variant="ghost" size="sm" onClick={() => setFilters(DEFAULTS)} className="self-end">
          <RotateCcw className="h-3.5 w-3.5" />
          Сброс
        </Button>
      </FilterBar>

      {view === 'tiles' ? (
        <TileGrid>
          {(list.data ?? []).map((c) => (
            <CounterpartyTile key={c.id} counterparty={c} onClick={() => setEditing(c)} />
          ))}
        </TileGrid>
      ) : (
      <div className="bg-card">
        <DataTable
          data={list.data ?? []}
          columns={columns}
          rowKey={(c) => c.id}
          onRowClick={(c) => setEditing(c)}
          loading={list.isLoading}
          error={list.error}
          onRetry={() => list.refetch()}
          empty={
            <EmptyState
              icon={Users}
              title="Пока нет контрагентов"
              hint="Добавьте клиента или поставщика, чтобы привязывать к ним операции."
              action={
                <Button onClick={() => setCreating(true)}>
                  <Plus className="h-4 w-4" /> Добавить
                </Button>
              }
            />
          }
          mobileCards={(c) => (
            <div className="flex flex-col gap-0.5">
              <div className="font-medium">{c.name}</div>
              {c.contact && (
                <div className="text-xs text-muted-foreground">{c.contact}</div>
              )}
              {c.note && (
                <div className="line-clamp-2 text-xs text-muted-foreground">{c.note}</div>
              )}
            </div>
          )}
        />
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
    </>
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
  const [confirmDel, setConfirmDel] = useState(false);

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

  // Несохранённый ввод — против значений, с которыми форма открылась.
  const dirty =
    name !== (initial?.name ?? '') ||
    contact !== (initial?.contact ?? '') ||
    note !== (initial?.note ?? '') ||
    isArchived !== (initial?.isArchived ?? false);

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
    await del.mutateAsync(initial.id);
    onClose();
  };

  return (
    <>
      <Modal open={open} onOpenChange={(o) => !o && onClose()} dirty={dirty}>
        <ModalContent hideClose>
          <ModalHeader className="flex-row items-center justify-between gap-2 space-y-0">
            <ModalTitle>
              {initial ? 'Редактировать контрагента' : 'Новый контрагент'}
            </ModalTitle>
            <ModalClose asChild>
              <Button variant="ghost" size="icon" aria-label="Закрыть">
                <X className="h-4 w-4" />
              </Button>
            </ModalClose>
          </ModalHeader>
          <form
            className="flex min-h-0 flex-1 flex-col"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void onSave();
            }}
          >
          <ModalBody className="space-y-4">
            <FormField label="Имя / название" htmlFor="cp-name" required>
              <Input
                id="cp-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
            </FormField>
            <FormField label="Контакт" htmlFor="cp-contact">
              <Input
                id="cp-contact"
                value={contact}
                onChange={(e) => setContact(e.target.value)}
                placeholder="телефон, email, @username"
              />
            </FormField>
            <FormField label="Примечание" htmlFor="cp-note">
              <Textarea
                id="cp-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
              />
            </FormField>
            {initial && (
              <Checkbox label="В архиве" checked={isArchived} onChange={(e) => setIsArchived(e.target.checked)} />
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
          </ModalBody>
          <ModalFooter>
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
            <ModalClose asChild>
              <Button type="button" variant="secondary">
                Отмена
              </Button>
            </ModalClose>
            <Button
              type="submit"
              loading={create.isPending || update.isPending}
              disabled={!name.trim()}
            >
              Сохранить
            </Button>
          </ModalFooter>
          </form>
        </ModalContent>
      </Modal>
      <ConfirmDialog
        open={confirmDel}
        onOpenChange={setConfirmDel}
        title={`Удалить «${initial?.name ?? ''}»?`}
        description="Контрагент переместится в архив, привязки в операциях сохранятся."
        confirmText="Удалить"
        onConfirm={onDelete}
        loading={del.isPending}
      />
    </>
  );
}
