'use client';

import { useEffect, useState } from 'react';
import { Plus, Tag, ChevronRight, ChevronDown, X, Trash2 } from 'lucide-react';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import {
  useCategoryTree,
  useCategories,
  useCreateCategory,
  useUpdateCategory,
  useDeleteCategory,
} from '@/hooks/useCategories';
import type { Category, CategoryKind, CategoryTreeNode } from '@/lib/types';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
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
import { cn } from '@/lib/cn';

export default function CategoriesPage() {
  const { current } = useCurrentWorkspace();
  const wsId = current?.id ?? null;
  const [kind, setKind] = useState<CategoryKind>('EXPENSE');
  const tree = useCategoryTree(wsId, kind);
  const flat = useCategories(wsId, kind);
  const [editing, setEditing] = useState<Category | null>(null);
  const [creating, setCreating] = useState<{ parentId: string | null } | null>(null);

  if (!current) {
    return (
      <>
        <PageHeader title="Категории" />
        <div className="p-6">
          <EmptyState
            icon={Tag}
            title="Нет активного пространства"
            hint="Выберите или создайте пространство."
          />
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Категории"
        breadcrumbs={[{ label: 'Справочники' }, { label: 'Категории' }]}
        actions={
          <Button onClick={() => setCreating({ parentId: null })}>
            <Plus className="h-4 w-4" />
            Добавить
          </Button>
        }
      />

      <div className="px-6 py-4">
        <Tabs value={kind} onValueChange={(v) => setKind(v as CategoryKind)}>
          <TabsList>
            <TabsTrigger value="EXPENSE">Расходы</TabsTrigger>
            <TabsTrigger value="INCOME">Доходы</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <div className="px-6 pb-6">
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          {tree.isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : !tree.data || tree.data.length === 0 ? (
            <EmptyState
              icon={Tag}
              title={
                kind === 'EXPENSE'
                  ? 'Нет категорий расходов'
                  : 'Нет категорий доходов'
              }
              hint="Создайте корневую категорию, потом добавьте подкатегории."
              action={
                <Button onClick={() => setCreating({ parentId: null })}>
                  <Plus className="h-4 w-4" /> Добавить
                </Button>
              }
            />
          ) : (
            <ul className="divide-y divide-border">
              {tree.data.map((node) => (
                <CategoryNode
                  key={node.id}
                  node={node}
                  depth={0}
                  onEdit={setEditing}
                  onAddChild={(parentId) => setCreating({ parentId })}
                />
              ))}
            </ul>
          )}
        </div>
      </div>

      <CategoryForm
        wsId={current.id}
        open={creating !== null || !!editing}
        kind={kind}
        initial={editing}
        parentId={creating?.parentId ?? null}
        parents={flat.data?.filter((c) => c.parentId === null) ?? []}
        onClose={() => {
          setCreating(null);
          setEditing(null);
        }}
      />
    </>
  );
}

function CategoryNode({
  node,
  depth,
  onEdit,
  onAddChild,
}: {
  node: CategoryTreeNode;
  depth: number;
  onEdit: (c: Category) => void;
  onAddChild: (parentId: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.children.length > 0;

  return (
    <>
      <li
        className={cn(
          'group flex items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-secondary',
        )}
        style={{ paddingLeft: 12 + depth * 24 }}
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren) setExpanded((v) => !v);
          }}
          aria-label={hasChildren ? (expanded ? 'Свернуть' : 'Развернуть') : undefined}
          className="flex h-5 w-5 shrink-0 items-center justify-center text-muted-foreground"
        >
          {hasChildren ? (
            expanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )
          ) : (
            <span className="block h-1 w-1 rounded-full bg-border" />
          )}
        </button>
        <button
          type="button"
          className="min-w-0 flex-1 cursor-pointer truncate text-left"
          onClick={() => onEdit(node)}
        >
          {node.name}
        </button>
        {node.isFixedCost && <Badge variant="outline">Постоянная</Badge>}
        {node.isArchived && <Badge variant="muted">В архиве</Badge>}
        {depth === 0 && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onAddChild(node.id);
            }}
            className="ml-2 inline-flex items-center gap-1 text-xs text-primary opacity-0 transition-opacity hover:underline group-hover:opacity-100 focus:opacity-100"
          >
            <Plus className="h-3 w-3" /> подкатегория
          </button>
        )}
      </li>
      {hasChildren && expanded &&
        node.children.map((child) => (
          <CategoryNode
            key={child.id}
            node={child}
            depth={depth + 1}
            onEdit={onEdit}
            onAddChild={onAddChild}
          />
        ))}
    </>
  );
}

function CategoryForm({
  wsId,
  open,
  kind,
  initial,
  parentId,
  parents,
  onClose,
}: {
  wsId: string;
  open: boolean;
  kind: CategoryKind;
  initial: Category | null;
  parentId: string | null;
  parents: Category[];
  onClose: () => void;
}) {
  const create = useCreateCategory(wsId);
  const update = useUpdateCategory(wsId);
  const del = useDeleteCategory(wsId);
  const [name, setName] = useState('');
  const [parent, setParent] = useState<string>('');
  const [isFixedCost, setIsFixedCost] = useState(false);
  const [isArchived, setIsArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);

  useEffect(() => {
    if (initial) {
      setName(initial.name);
      setParent(initial.parentId ?? '');
      setIsFixedCost(initial.isFixedCost);
      setIsArchived(initial.isArchived);
    } else {
      setName('');
      setParent(parentId ?? '');
      setIsFixedCost(false);
      setIsArchived(false);
    }
    setError(null);
  }, [initial, parentId, open]);

  const onSave = async () => {
    setError(null);
    try {
      if (initial) {
        await update.mutateAsync({
          id: initial.id,
          name: name.trim(),
          parentId: parent || null,
          isFixedCost,
          isArchived,
        });
      } else {
        await create.mutateAsync({
          name: name.trim(),
          kind,
          parentId: parent || null,
          isFixedCost,
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
        <SheetContent side="right" hideClose className="sm:max-w-md">
          <SheetHeader className="flex-row items-center justify-between gap-2 space-y-0">
            <SheetTitle>
              {initial ? 'Редактировать категорию' : 'Новая категория'}
            </SheetTitle>
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="Закрыть">
              <X className="h-4 w-4" />
            </Button>
          </SheetHeader>
          <SheetBody className="space-y-4">
            <FormField label="Название" htmlFor="cat-name" required>
              <Input
                id="cat-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
            </FormField>
            <FormField
              label="Родитель"
              htmlFor="cat-parent"
              hint="Поддерживается 2 уровня: только корневые могут быть родителями."
            >
              <Select
                id="cat-parent"
                value={parent}
                onChange={(e) => setParent(e.target.value)}
              >
                <option value="">— Корневая —</option>
                {parents
                  .filter((p) => !initial || p.id !== initial.id)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </Select>
            </FormField>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={isFixedCost}
                onChange={(e) => setIsFixedCost(e.target.checked)}
                className="h-4 w-4 rounded border-input accent-primary"
              />
              Постоянная издержка
            </label>
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
                <Trash2 className="h-3.5 w-3.5" /> Удалить
              </Button>
            )}
            <Button variant="secondary" onClick={onClose}>
              Отмена
            </Button>
            <Button onClick={onSave} disabled={!name.trim()}>
              Сохранить
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
      <ConfirmDialog
        open={confirmDel}
        onOpenChange={setConfirmDel}
        title={`Удалить «${initial?.name ?? ''}»?`}
        description="Категория переместится в архив, связи с операциями сохранятся."
        confirmText="Удалить"
        onConfirm={onDelete}
        loading={del.isPending}
      />
    </>
  );
}
