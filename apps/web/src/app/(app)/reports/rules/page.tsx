'use client';

import { useEffect, useState } from 'react';
import { Plus, Filter, X, Trash2, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
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
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useCategories } from '@/hooks/useCategories';
import {
  useCategoryRules,
  useCreateCategoryRule,
  useDeleteCategoryRule,
  useUpdateCategoryRule,
} from '@/hooks/useCategoryRules';
import type { CategoryRule } from '@/lib/types';

export default function CategoryRulesPage() {
  const ws = useCurrentWorkspace();
  const wsId = ws.currentId;
  const rules = useCategoryRules(wsId, true);
  const categories = useCategories(wsId);
  const createMut = useCreateCategoryRule(wsId ?? '');
  const updateMut = useUpdateCategoryRule(wsId ?? '');
  const deleteMut = useDeleteCategoryRule(wsId ?? '');

  const [editing, setEditing] = useState<CategoryRule | null>(null);
  const [open, setOpen] = useState(false);
  const [delTarget, setDelTarget] = useState<CategoryRule | null>(null);

  if (!wsId) {
    return (
      <div className="p-6">
        <EmptyState
          icon={Filter}
          title="Нет активного пространства"
          hint="Выберите или создайте пространство."
        />
      </div>
    );
  }

  function openCreate() {
    setEditing(null);
    setOpen(true);
  }
  function openEdit(r: CategoryRule) {
    setEditing(r);
    setOpen(true);
  }

  const columns: Column<CategoryRule>[] = [
    {
      key: 'keyword',
      header: 'Ключевое слово',
      cell: (r) => <span className="font-medium">{r.keyword}</span>,
    },
    {
      key: 'category',
      header: 'Категория',
      cell: (r) => <span className="text-muted-foreground">{r.category?.name ?? '—'}</span>,
    },
    {
      key: 'priority',
      header: 'Приоритет',
      align: 'right',
      sortable: true,
      cell: (r) => r.priority,
      className: 'w-[110px]',
    },
    {
      key: 'active',
      header: 'Статус',
      cell: (r) => (
        <label
          className="inline-flex items-center gap-2"
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={r.isActive}
            onChange={(e) =>
              updateMut.mutate({ id: r.id, isActive: e.target.checked })
            }
            className="h-4 w-4 rounded border-input accent-primary"
          />
          {r.isActive ? (
            <Badge variant="outline">Активно</Badge>
          ) : (
            <Badge variant="muted">Пауза</Badge>
          )}
        </label>
      ),
      className: 'w-[140px]',
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (r) => (
        <div className="inline-flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <Button variant="ghost" size="icon" onClick={() => openEdit(r)} aria-label="Изменить">
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setDelTarget(r)}
            aria-label="Удалить"
            className="text-destructive hover:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ),
      className: 'w-[100px]',
    },
  ];

  return (
    <>
      <div className="border-b border-border bg-background px-6 py-3">
        <div className="flex items-center justify-between gap-3">
          <p className="max-w-3xl text-sm text-muted-foreground">
            Если описание или контрагент содержит ключевое слово, при импорте
            автоматически предлагается категория. Сравнение без учёта регистра,
            побеждает правило с большим приоритетом.
          </p>
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4" /> Новое правило
          </Button>
        </div>
      </div>

      <div className="bg-card">
        <DataTable
          data={rules.data ?? []}
          columns={columns}
          rowKey={(r) => r.id}
          loading={rules.isLoading}
          empty={
            <EmptyState
              icon={Filter}
              title="Правил пока нет"
              hint="Создайте правило, чтобы при импорте автоматически проставлять категорию."
              action={
                <Button onClick={openCreate}>
                  <Plus className="h-4 w-4" /> Новое правило
                </Button>
              }
            />
          }
          mobileCards={(r) => (
            <div className="space-y-0.5">
              <div className="font-medium">{r.keyword}</div>
              <div className="text-xs text-muted-foreground">
                {r.category?.name ?? '—'} · приоритет {r.priority}
              </div>
            </div>
          )}
        />
      </div>

      <RuleFormDialog
        open={open}
        onClose={() => setOpen(false)}
        editing={editing}
        categories={categories.data ?? []}
        onSubmit={async (input) => {
          if (editing) await updateMut.mutateAsync({ id: editing.id, ...input });
          else await createMut.mutateAsync(input);
          setOpen(false);
        }}
      />

      <ConfirmDialog
        open={!!delTarget}
        onOpenChange={(o) => !o && setDelTarget(null)}
        title={`Удалить правило «${delTarget?.keyword ?? ''}»?`}
        confirmText="Удалить"
        onConfirm={async () => {
          if (delTarget) await deleteMut.mutateAsync(delTarget.id);
          setDelTarget(null);
        }}
        loading={deleteMut.isPending}
      />
    </>
  );
}

function RuleFormDialog({
  open,
  onClose,
  editing,
  categories,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  editing: CategoryRule | null;
  categories: { id: string; name: string; kind: string }[];
  onSubmit: (input: {
    keyword: string;
    categoryId: string;
    priority: number;
    isActive: boolean;
  }) => Promise<void>;
}) {
  const [keyword, setKeyword] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [priority, setPriority] = useState(0);
  const [isActive, setIsActive] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setKeyword(editing.keyword);
      setCategoryId(editing.categoryId);
      setPriority(editing.priority);
      setIsActive(editing.isActive);
    } else {
      setKeyword('');
      setCategoryId(categories[0]?.id ?? '');
      setPriority(0);
      setIsActive(true);
    }
  }, [open, editing, categories]);

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" hideClose className="sm:max-w-md">
        <SheetHeader className="flex-row items-center justify-between gap-2 space-y-0">
          <SheetTitle>{editing ? 'Изменить правило' : 'Новое правило'}</SheetTitle>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Закрыть">
            <X className="h-4 w-4" />
          </Button>
        </SheetHeader>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!keyword.trim() || !categoryId) return;
            setBusy(true);
            try {
              await onSubmit({
                keyword: keyword.trim(),
                categoryId,
                priority,
                isActive,
              });
            } finally {
              setBusy(false);
            }
          }}
        >
          <SheetBody className="space-y-4">
            <FormField label="Ключевое слово" htmlFor="keyword" required>
              <Input
                id="keyword"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="например, starbucks"
                required
              />
            </FormField>
            <FormField label="Категория" htmlFor="categoryId" required>
              <Select
                id="categoryId"
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
                required
              >
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField
              label="Приоритет"
              htmlFor="priority"
              hint="Больше приоритет — выше шансы сработать первым."
            >
              <Input
                id="priority"
                type="number"
                min={0}
                max={1000}
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value))}
              />
            </FormField>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={isActive}
                onChange={(e) => setIsActive(e.target.checked)}
                className="h-4 w-4 rounded border-input accent-primary"
              />
              Активно
            </label>
          </SheetBody>
          <SheetFooter>
            <Button type="button" variant="secondary" onClick={onClose}>
              Отмена
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? 'Сохраняю…' : 'Сохранить'}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
