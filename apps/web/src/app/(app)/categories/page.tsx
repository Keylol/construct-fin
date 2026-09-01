'use client';

import { useEffect, useState } from 'react';
import { Plus, Tag, ChevronRight, ChevronDown, X, Trash2 } from '@/components/ui/icons';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import {
  useCategoryTree,
  useCategories,
  useCreateCategory,
  useUpdateCategory,
  useDeleteCategory,
} from '@/hooks/useCategories';
import type {
  Category,
  CategoryBucket,
  CategoryKind,
  CategoryTreeNode,
} from '@/lib/types';
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
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/Modal';
import { cn } from '@/lib/cn';

/**
 * Группа решает, куда категория попадёт в ОПиУ. Пояснения даны через последствие
 * («войдёт в валовую прибыль» / «не войдёт»), а не через бухгалтерский термин:
 * выбирает их владелец, а ошибка здесь тихо искажает прибыль.
 */
const BUCKET_LABEL: Record<CategoryBucket, string> = {
  REVENUE: 'Выручка',
  COGS: 'Себестоимость проданного',
  PURCHASES: 'Закупка товара',
  FIXED: 'Постоянные расходы',
  VARIABLE: 'Переменные расходы',
  TAX: 'Налоги',
  CAPITAL: 'Вложения и изъятия',
  OTHER: 'Прочее',
};

const BUCKET_HINT: Record<CategoryBucket, string> = {
  // Группа работает в обе стороны: доход увеличивает выручку, расход — уменьшает
  // (ОПиУ считает выручку как нетто). Поэтому «Выручка» доступна и расходу.
  REVENUE:
    'Продажи. У дохода увеличивает выручку, у расхода — уменьшает её (возврат клиенту), а не раздувает расходы.',
  COGS: 'Себестоимость проданного. Если товар продаётся через заказы, её считает сам заказ — тогда закупку помечайте группой «Закупка товара», иначе расход учтётся дважды.',
  PURCHASES: 'Расход на товар. Виден в отчётах и в движении денег, но в валовую прибыль не входит — её даёт закрытый заказ.',
  FIXED: 'Не зависят от объёма продаж: аренда, подписки, оклады.',
  VARIABLE: 'Растут вместе с продажами: реклама, доставка, комиссии.',
  TAX: 'Налоги и взносы.',
  CAPITAL: 'Вложения и изъятия собственника. В прибыль не входят, видны только в движении денег.',
  OTHER: 'Не подходит под остальные группы.',
};

// Совпадает с ALLOWED_BUCKETS на сервере (M13): себестоимость и закупки — только
// расходу. Разойдётся — форма начнёт получать 400. «Выручка» есть у расхода
// намеренно: это возврат клиенту, он уменьшает выручку, а не увеличивает расходы.
const INCOME_BUCKETS: CategoryBucket[] = ['REVENUE', 'CAPITAL', 'OTHER'];
const EXPENSE_BUCKETS: CategoryBucket[] = [
  'COGS',
  'PURCHASES',
  'FIXED',
  'VARIABLE',
  'TAX',
  'REVENUE',
  'CAPITAL',
  'OTHER',
];

/**
 * Варианты для выбора. Текущее значение добавляем, даже если оно вне списка:
 * категории, заведённые до проверки kind↔bucket, могут держать недопустимую пару
 * (например «Закупка товара (возврат)» — доход с себестоимостью). Молча подменить
 * её первым вариантом значило бы переписать группу без ведома владельца.
 */
function bucketOptions(kind: CategoryKind, current: CategoryBucket): CategoryBucket[] {
  const allowed = kind === 'INCOME' ? INCOME_BUCKETS : EXPENSE_BUCKETS;
  return allowed.includes(current) ? allowed : [current, ...allowed];
}

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
        {/* Группа отчёта видна в списке: именно она решает, попадёт ли расход в
            валовую прибыль, и ошибку в ней иначе замечают только по кривому ОПиУ.
            shrink-0 обязателен — иначе длинная подпись группы («Себестоимость
            проданного») сжимает соседнее название категории до нуля. На узких
            экранах группу прячем: название важнее, а группа видна в карточке. */}
        <Badge variant="muted" className="hidden shrink-0 sm:inline-flex">
          {BUCKET_LABEL[node.bucket]}
        </Badge>
        {node.isFixedCost && (
          <Badge variant="outline" className="shrink-0">
            Постоянная
          </Badge>
        )}
        {node.isArchived && (
          <Badge variant="muted" className="shrink-0">
            В архиве
          </Badge>
        )}
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
  const [bucket, setBucket] = useState<CategoryBucket>('OTHER');
  const [isFixedCost, setIsFixedCost] = useState(false);
  const [isArchived, setIsArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);

  useEffect(() => {
    if (initial) {
      setName(initial.name);
      setParent(initial.parentId ?? '');
      setBucket(initial.bucket);
      setIsFixedCost(initial.isFixedCost);
      setIsArchived(initial.isArchived);
    } else {
      setName('');
      setParent(parentId ?? '');
      setBucket(kind === 'INCOME' ? 'REVENUE' : 'OTHER');
      setIsFixedCost(false);
      setIsArchived(false);
    }
    setError(null);
  }, [initial, parentId, kind, open]);

  const onSave = async () => {
    setError(null);
    try {
      if (initial) {
        await update.mutateAsync({
          id: initial.id,
          name: name.trim(),
          bucket,
          parentId: parent || null,
          isFixedCost,
          isArchived,
        });
      } else {
        await create.mutateAsync({
          name: name.trim(),
          kind,
          bucket,
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
      <Modal open={open} onOpenChange={(o) => !o && onClose()}>
        <ModalContent hideClose>
          <ModalHeader className="flex-row items-center justify-between gap-2 space-y-0">
            <ModalTitle>
              {initial ? 'Редактировать категорию' : 'Новая категория'}
            </ModalTitle>
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
            <FormField label="Название" htmlFor="cat-name" required>
              <Input
                id="cat-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
            </FormField>
            <FormField
              label="Группа в отчёте"
              htmlFor="cat-bucket"
              hint={BUCKET_HINT[bucket]}
            >
              <Select
                id="cat-bucket"
                value={bucket}
                onChange={(e) => setBucket(e.target.value as CategoryBucket)}
              >
                {bucketOptions(kind, bucket).map((b) => (
                  <option key={b} value={b}>
                    {BUCKET_LABEL[b]}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField
              label="Родительская категория"
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
              Постоянные расходы
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
        description="Категория переместится в архив, связи с операциями сохранятся."
        confirmText="В архив"
        onConfirm={onDelete}
        loading={del.isPending}
      />
    </>
  );
}
