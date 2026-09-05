'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, UserRound, Search, X, Trash2, Pencil } from '@/components/ui/icons';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useListHotkeys } from '@/hooks/useListHotkeys';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useCreateFromUrl } from '@/hooks/useCreateFromUrl';
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
} from '@/components/ui/Modal';

export default function ClientsPage() {
  const router = useRouter();
  const { current } = useCurrentWorkspace();
  const wsId = current?.id ?? null;
  const [search, setSearch] = useState('');
  /**
   * Куда ведёт клик по клиенту. Владелец идёт к заказу, а не к справочной
   * карточке: один заказ — открываем его сразу, несколько — показываем только
   * его заказы, ни одного — остаётся карточка клиента.
   */
  const clientTarget = (c: Counterparty) => {
    const s = c.summary;
    if (s?.ordersCount === 1 && s.lastOrderId) return `/orders?order=${s.lastOrderId}`;
    if (s && s.ordersCount > 1) return `/orders?client=${c.id}`;
    return `/clients/${c.id}`;
  };

  // Вид: справочник обычно смотрят списком, плитки — когда следят за долгами.
  const [view, changeView] = useTileView('clients:view');
  // В инпуте — сырой search, в запрос уходит значение после паузы в наборе.
  const debouncedSearch = useDebouncedValue(search);
  // Архив по умолчанию скрыт, но должен быть достижим: без этого переключателя
  // отправленная в архив карточка исчезала из интерфейса совсем — вернуть её
  // было нечем ни на одной странице.
  const [showArchived, setShowArchived] = useState(false);
  const list = useCounterparties(wsId, debouncedSearch || undefined, showArchived, 'CLIENT');
  const [editing, setEditing] = useState<Counterparty | null>(null);
  const [creating, setCreating] = useState(false);
  // «/» — в поиск, «n» — создать: список листают с клавиатуры.
  const searchRef = useRef<HTMLInputElement>(null);
  useListHotkeys({ searchRef, onNew: () => setCreating(true) });
  // Глобальное «+ Создать» → ?new=1 открывает форму клиента.
  useCreateFromUrl(() => setCreating(true));

  if (!current) {
    return (
      <>
        <PageHeader title="Клиенты" />
        <div className="p-6">
          <EmptyState
            icon={UserRound}
            title="Нет активного пространства"
            hint="Выберите или создайте пространство."
          />
        </div>
      </>
    );
  }

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
      key: 'source',
      header: 'Источник',
      cell: (c) =>
        c.source ? (
          <Badge variant="outline">{c.source}</Badge>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
      className: 'w-[160px]',
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
    {
      // Клик по строке ведёт на карточку — редактирование вынесено на явную
      // кнопку-карандаш (stopPropagation, чтобы не сработала навигация).
      key: 'actions',
      header: '',
      align: 'right',
      hoverOnly: true,
      cell: (c) => (
        <Button
          variant="ghost"
          size="icon"
          onClick={(e) => {
            e.stopPropagation();
            setEditing(c);
          }}
          aria-label="Редактировать клиента"
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
        title="Клиенты"
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" />
            Добавить
          </Button>
        }
      />

      <FilterBar>
        <div className="min-w-[240px] max-w-md flex-1">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchRef}
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Поиск по имени или контакту"
              className="h-9 pl-8"
            />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
            className="h-4 w-4 rounded border-border"
          />
          Показывать архив
        </label>
        <ViewToggle view={view} onChange={changeView} />
      </FilterBar>

      {view === 'tiles' ? (
        <TileGrid>
          {(list.data ?? []).map((c) => (
            <CounterpartyTile
              key={c.id}
              counterparty={c}
              onClick={() => router.push(clientTarget(c) as Parameters<typeof router.push>[0])}
            />
          ))}
        </TileGrid>
      ) : (
      <div className="bg-card">
        <DataTable
          data={list.data ?? []}
          columns={columns}
          rowKey={(c) => c.id}
          onRowClick={(c) => router.push(`/clients/${c.id}` as Parameters<typeof router.push>[0])}
          loading={list.isLoading}
          error={list.error}
          onRetry={() => list.refetch()}
          empty={
            <EmptyState
              icon={UserRound}
              title="Пока нет клиентов"
              hint="Добавьте клиента, чтобы привязывать к нему заказы и видеть выручку."
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
                {c.contact && (
                  <div className="truncate text-xs text-muted-foreground">{c.contact}</div>
                )}
                {c.source && (
                  <div className="truncate text-xs text-muted-foreground">Источник: {c.source}</div>
                )}
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={(e) => {
                  e.stopPropagation();
                  setEditing(c);
                }}
                aria-label="Редактировать клиента"
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
        />
      </div>
      )}

      <ClientForm
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

function ClientForm({
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
  const [source, setSource] = useState('');
  const [note, setNote] = useState('');
  const [isArchived, setIsArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);

  useEffect(() => {
    if (initial) {
      setName(initial.name);
      setContact(initial.contact ?? '');
      setSource(initial.source ?? '');
      setNote(initial.note ?? '');
      setIsArchived(initial.isArchived);
    } else {
      setName('');
      setContact('');
      setSource('');
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
          role: 'CLIENT',
          contact: contact.trim() || null,
          source: source.trim() || null,
          note: note.trim() || null,
          isArchived,
        });
      } else {
        await create.mutateAsync({
          name: name.trim(),
          role: 'CLIENT',
          contact: contact.trim() || undefined,
          source: source.trim() || undefined,
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
      <Modal open={open} onOpenChange={(o) => !o && onClose()}>
        <ModalContent hideClose>
          <ModalHeader className="flex-row items-center justify-between gap-2 space-y-0">
            <ModalTitle>{initial ? 'Редактировать клиента' : 'Новый клиент'}</ModalTitle>
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="Закрыть">
              <X className="h-4 w-4" />
            </Button>
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
            <FormField label="Имя / название" htmlFor="cl-name" required>
              <Input
                id="cl-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
            </FormField>
            <FormField label="Контакт" htmlFor="cl-contact">
              <Input
                id="cl-contact"
                value={contact}
                onChange={(e) => setContact(e.target.value)}
                placeholder="телефон, email, @username"
              />
            </FormField>
            <FormField
              label="Источник"
              htmlFor="cl-source"
              hint="Откуда пришёл: Avito, рекомендация, Telegram…"
            >
              <Input
                id="cl-source"
                value={source}
                onChange={(e) => setSource(e.target.value)}
              />
            </FormField>
            <FormField label="Примечание" htmlFor="cl-note">
              <Textarea
                id="cl-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
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
          </ModalFooter>
          </form>
        </ModalContent>
      </Modal>
      <ConfirmDialog
        open={confirmDel}
        onOpenChange={setConfirmDel}
        title={`Архивировать «${initial?.name ?? ''}»?`}
        description="Клиент переместится в архив, его заказы сохранятся."
        confirmText="В архив"
        onConfirm={onDelete}
        loading={del.isPending}
      />
    </>
  );
}
