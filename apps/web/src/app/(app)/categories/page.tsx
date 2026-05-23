'use client';

import { useEffect, useState } from 'react';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import {
  useCategoryTree,
  useCategories,
  useCreateCategory,
  useUpdateCategory,
  useDeleteCategory,
} from '@/hooks/useCategories';
import type { Category, CategoryKind, CategoryTreeNode } from '@/lib/types';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Label } from '@/components/ui/Label';
import { EmptyState } from '@/components/ui/EmptyState';
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
    return <EmptyState title="Нет активного пространства" hint="Выберите или создайте пространство." />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Категории</h1>
        <Button size="sm" onClick={() => setCreating({ parentId: null })}>+ Добавить</Button>
      </div>

      <div className="flex gap-2">
        <Button
          variant={kind === 'EXPENSE' ? 'primary' : 'secondary'}
          size="sm"
          onClick={() => setKind('EXPENSE')}
        >
          Расходы
        </Button>
        <Button
          variant={kind === 'INCOME' ? 'primary' : 'secondary'}
          size="sm"
          onClick={() => setKind('INCOME')}
        >
          Доходы
        </Button>
      </div>

      {tree.isLoading && <Card>Загрузка…</Card>}
      {tree.error && <Card className="text-danger">Ошибка: {String(tree.error)}</Card>}

      {tree.data && tree.data.length === 0 && (
        <EmptyState
          title={kind === 'EXPENSE' ? 'Нет категорий расходов' : 'Нет категорий доходов'}
          hint="Создайте корневую категорию, потом можно добавить подкатегории."
          action={<Button onClick={() => setCreating({ parentId: null })}>+ Добавить</Button>}
        />
      )}

      {tree.data && tree.data.length > 0 && (
        <Card className="!p-3">
          {tree.data.map((node) => (
            <CategoryRow
              key={node.id}
              node={node}
              onEdit={setEditing}
              onAddChild={(parentId) => setCreating({ parentId })}
              depth={0}
            />
          ))}
        </Card>
      )}

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
    </div>
  );
}

function CategoryRow({
  node,
  onEdit,
  onAddChild,
  depth,
}: {
  node: CategoryTreeNode;
  onEdit: (c: Category) => void;
  onAddChild: (parentId: string) => void;
  depth: number;
}) {
  return (
    <>
      <div
        className={cn(
          'flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-glass/40 transition cursor-pointer',
        )}
        style={{ paddingLeft: 12 + depth * 24 }}
        onClick={() => onEdit(node)}
      >
        {node.children.length > 0 && <span className="text-muted text-xs">▾</span>}
        <span className="flex-1">
          {node.name}
          {node.isFixedCost && (
            <span className="ml-2 text-xs text-tint">пост.</span>
          )}
          {node.isArchived && <span className="ml-2 text-xs text-muted">арх.</span>}
        </span>
        {depth === 0 && (
          <button
            type="button"
            className="text-tint text-sm hover:underline"
            onClick={(e) => {
              e.stopPropagation();
              onAddChild(node.id);
            }}
          >
            + дочерняя
          </button>
        )}
      </div>
      {node.children.map((child) => (
        <CategoryRow
          key={child.id}
          node={child}
          onEdit={onEdit}
          onAddChild={onAddChild}
          depth={depth + 1}
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
    if (!confirm(`Удалить категорию «${initial.name}»?`)) return;
    try {
      await del.mutateAsync(initial.id);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={initial ? 'Редактировать категорию' : 'Новая категория'}>
      <div className="space-y-3">
        <div>
          <Label htmlFor="cat-name">Название</Label>
          <Input id="cat-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </div>
        <div>
          <Label htmlFor="cat-parent">Родитель</Label>
          <Select id="cat-parent" value={parent} onChange={(e) => setParent(e.target.value)}>
            <option value="">— Корневая —</option>
            {parents
              .filter((p) => !initial || p.id !== initial.id)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </Select>
          <p className="text-xs text-muted mt-1">
            Поддерживается 2 уровня: только корневые могут быть родителями.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm text-fg/80">
          <input type="checkbox" checked={isFixedCost} onChange={(e) => setIsFixedCost(e.target.checked)} />
          Постоянная издержка
        </label>
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
          <Button onClick={onSave} disabled={!name.trim()} className="flex-1">
            Сохранить
          </Button>
        </div>
      </div>
    </Modal>
  );
}
