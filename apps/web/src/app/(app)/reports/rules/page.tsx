'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
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

  if (!wsId) return <EmptyState title="Workspace не выбран" />;

  function openCreate() {
    setEditing(null);
    setOpen(true);
  }

  function openEdit(r: CategoryRule) {
    setEditing(r);
    setOpen(true);
  }

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <p className="text-muted text-sm">
          Если описание или контрагент содержит ключевое слово, при импорте предлагается
          указанная категория. Сравнение без учёта регистра. Приоритет выше — побеждает.
        </p>
        <Button onClick={openCreate}>Новое правило</Button>
      </header>

      {rules.isLoading && <p className="text-muted text-sm">Загрузка…</p>}
      {rules.data && rules.data.length === 0 && (
        <EmptyState
          title="Правил пока нет"
          hint="Создайте правило, чтобы при импорте автоматически проставлять категорию."
        />
      )}

      {rules.data && rules.data.length > 0 && (
        <Card>
          <table className="w-full text-sm">
            <thead className="text-muted text-left text-xs uppercase">
              <tr>
                <th className="py-2">Ключевое слово</th>
                <th className="py-2">Категория</th>
                <th className="py-2 text-right">Приоритет</th>
                <th className="py-2 text-center">Активно</th>
                <th className="py-2 text-right"></th>
              </tr>
            </thead>
            <tbody>
              {rules.data.map((r) => (
                <tr key={r.id} className="border-t border-glass-border">
                  <td className="py-2 font-medium">{r.keyword}</td>
                  <td className="py-2 text-muted">{r.category?.name ?? '—'}</td>
                  <td className="py-2 text-right">{r.priority}</td>
                  <td className="py-2 text-center">
                    <input
                      type="checkbox"
                      checked={r.isActive}
                      onChange={(e) =>
                        updateMut.mutate({ id: r.id, isActive: e.target.checked })
                      }
                    />
                  </td>
                  <td className="py-2 text-right">
                    <button
                      className="mr-3 text-blue-500 hover:underline"
                      onClick={() => openEdit(r)}
                    >
                      Изменить
                    </button>
                    <button
                      className="text-rose-500 hover:underline"
                      onClick={() => {
                        if (confirm(`Удалить правило «${r.keyword}»?`)) deleteMut.mutate(r.id);
                      }}
                    >
                      Удалить
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

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
    </div>
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
  const [keyword, setKeyword] = useState(editing?.keyword ?? '');
  const [categoryId, setCategoryId] = useState(editing?.categoryId ?? categories[0]?.id ?? '');
  const [priority, setPriority] = useState(editing?.priority ?? 0);
  const [isActive, setIsActive] = useState(editing?.isActive ?? true);
  const [busy, setBusy] = useState(false);

  // reset when editing changes
  if (open && editing && editing.id !== undefined && keyword === '' && editing.keyword) {
    setKeyword(editing.keyword);
    setCategoryId(editing.categoryId);
    setPriority(editing.priority);
    setIsActive(editing.isActive);
  }

  return (
    <Modal open={open} onClose={onClose} title={editing ? 'Изменить правило' : 'Новое правило'}>
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!keyword.trim() || !categoryId) return;
          setBusy(true);
          try {
            await onSubmit({ keyword: keyword.trim(), categoryId, priority, isActive });
          } finally {
            setBusy(false);
          }
        }}
      >
        <div>
          <Label htmlFor="keyword">Ключевое слово</Label>
          <Input
            id="keyword"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="например, starbucks"
            required
          />
        </div>
        <div>
          <Label htmlFor="categoryId">Категория</Label>
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
        </div>
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <Label htmlFor="priority">Приоритет</Label>
            <Input
              id="priority"
              type="number"
              min={0}
              max={1000}
              value={priority}
              onChange={(e) => setPriority(Number(e.target.value))}
            />
          </div>
          <label className="mt-6 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
            />
            Активно
          </label>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? 'Сохраняем…' : 'Сохранить'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
