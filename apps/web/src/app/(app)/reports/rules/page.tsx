'use client';

import { useMemo, useState, Suspense, useRef } from 'react';
import { Plus, Filter, Trash2, Pencil } from '@/components/ui/icons';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { EmptyState } from '@/components/ui/EmptyState';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useCategories } from '@/hooks/useCategories';
import { useCounterparties } from '@/hooks/useCounterparties';
import { useAccounts } from '@/hooks/useAccounts';
import { useRules, useCreateRule, useUpdateRule, useDeleteRule } from '@/hooks/useRules';
import type { Rule, RuleAction, RuleCondition } from '@/lib/types';
import { RuleFormDialog } from '@/components/rules/RuleFormDialog';
import { APPLIES_TO_LABELS } from '@/components/rules/dictionaries';
import { useListHotkeys } from '@/hooks/useListHotkeys';
import { useUrlFilters } from '@/hooks/useUrlFilters';
import { flatCodec } from '@/lib/url-codec';
import { FilterBar, FilterReset } from '@/components/ui/FilterBar';
import { FilterField } from '@/components/ui/FilterField';
import { SearchField } from '@/components/ui/SearchField';

const DEFAULTS = { q: '', inactive: false };
const FILTERS = flatCodec(DEFAULTS);

// useSearchParams требует Suspense-границу на уровне page (Next 14 App Router).
export default function RulesPage() {
  return (
    <Suspense>
      <RulesView />
    </Suspense>
  );
}

function RulesView() {
  const ws = useCurrentWorkspace();
  const wsId = ws.currentId;
  const rules = useRules(wsId);
  const [filters, setFilters] = useUrlFilters(FILTERS);
  const searchRef = useRef<HTMLInputElement>(null);
  const categories = useCategories(wsId);
  const counterparties = useCounterparties(wsId);
  const accounts = useAccounts(wsId);
  const createMut = useCreateRule(wsId ?? '');
  const updateMut = useUpdateRule(wsId ?? '');
  const deleteMut = useDeleteRule(wsId ?? '');

  const [editing, setEditing] = useState<Rule | null>(null);
  const [open, setOpen] = useState(false);
  // «n» — новое правило.
  useListHotkeys({ searchRef, onNew: () => openCreate() });
  const [delTarget, setDelTarget] = useState<Rule | null>(null);

  // Справочники id→имя для человекочитаемой сводки условий/действий в таблице.
  const catName = useMemo(
    () => new Map((categories.data ?? []).map((c) => [c.id, c.name])),
    [categories.data],
  );
  const cpName = useMemo(
    () => new Map((counterparties.data ?? []).map((c) => [c.id, c.name])),
    [counterparties.data],
  );
  const accName = useMemo(
    () => new Map((accounts.data ?? []).map((a) => [a.id, a.name])),
    [accounts.data],
  );

  if (!wsId) return null;

  function openCreate() {
    setEditing(null);
    setOpen(true);
  }
  function openEdit(r: Rule) {
    setEditing(r);
    setOpen(true);
  }

  function describeCondition(c: RuleCondition): string {
    switch (c.type) {
      case 'DESCRIPTION_CONTAINS':
        return `описание содержит «${c.value}»`;
      case 'COUNTERPARTY_EQUALS':
        return `контрагент = ${cpName.get(c.counterpartyId) ?? '—'}`;
      case 'COUNTERPARTY_INN_IN':
        return c.values.length === 1
          ? `ИНН = ${c.values[0]}`
          : `ИНН — один из ${c.values.length}`;
      case 'ACCOUNT_EQUALS':
        return `счёт = ${accName.get(c.accountId) ?? '—'}`;
      case 'TYPE_EQUALS':
        return c.value === 'INCOME' ? 'тип = доход' : 'тип = расход';
      case 'AMOUNT_RANGE': {
        const parts: string[] = [];
        if (c.min != null && c.min !== '') parts.push(`от ${c.min}`);
        if (c.max != null && c.max !== '') parts.push(`до ${c.max}`);
        return `сумма ${parts.join(' ') || '—'}`;
      }
      case 'SOURCE_EQUALS':
        return c.value === 'IMPORT' ? 'источник = импорт' : 'источник = ручной';
    }
  }

  function describeAction(a: RuleAction): string {
    switch (a.type) {
      case 'SET_CATEGORY':
        return `категория → ${catName.get(a.categoryId) ?? '—'}`;
      case 'SET_COUNTERPARTY':
        return `контрагент → ${cpName.get(a.counterpartyId) ?? '—'}`;
      case 'SET_ACCOUNT':
        return `счёт → ${accName.get(a.accountId) ?? '—'}`;
    }
  }

  const columns: Column<Rule>[] = [
    {
      key: 'name',
      header: 'Правило',
      cell: (r) => (
        <div className="space-y-0.5">
          <div className="font-medium">{r.name}</div>
          <div className="text-xs text-muted-foreground">
            {r.conditions.map(describeCondition).join(' И ')}
          </div>
        </div>
      ),
    },
    {
      key: 'actions-summary',
      header: 'Действие',
      cell: (r) => (
        <span className="text-sm text-muted-foreground">
          {r.actions.map(describeAction).join(', ')}
        </span>
      ),
    },
    {
      key: 'appliesTo',
      header: 'Где',
      cell: (r) => <span className="text-muted-foreground">{APPLIES_TO_LABELS[r.appliesTo]}</span>,
      className: 'w-[120px]',
    },
    {
      // Обратная связь по правилу (паттерн Firefly III): ноль после перезалива
      // значит, что правило написано мимо реальных формулировок либо его
      // перекрывает более приоритетное.
      key: 'appliedCount',
      header: 'Проведено строк',
      align: 'right',
      cell: (r) =>
        r.appliedCount > 0 ? (
          <span className="tabular-nums">{r.appliedCount}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
      className: 'w-[120px]',
    },
    {
      key: 'priority',
      header: 'Приоритет',
      align: 'right',
      cell: (r) => r.priority,
      className: 'w-[110px]',
    },
    {
      key: 'active',
      header: 'Статус',
      // Один контрол: флажок и есть статус, точка рядом дублировала его.
      cell: (r) => (
        <span onClick={(e) => e.stopPropagation()}>
          <Checkbox
            checked={r.isActive}
            onChange={(e) => updateMut.mutate({ id: r.id, isActive: e.target.checked })}
            label={r.isActive ? 'Активно' : 'Пауза'}
          />
        </span>
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

  const q = filters.q.trim().toLowerCase();
  const rows = (rules.data ?? []).filter(
    (r) => (filters.inactive || r.isActive) && (!q || r.name.toLowerCase().includes(q)),
  );

  return (
    <>
      <FilterBar>
        <div className="min-w-[240px] max-w-md flex-1">
          <FilterField label="Поиск">
            <SearchField
              ref={searchRef}
              value={filters.q}
              onChange={(e) => setFilters({ ...filters, q: e.target.value })}
              placeholder="Название правила"
            />
          </FilterField>
        </div>
        <Checkbox
          label="Показывать неактивные"
          checked={filters.inactive}
          onChange={(e) => setFilters({ ...filters, inactive: e.target.checked })}
          className="self-center"
        />
        <FilterReset onClick={() => setFilters(DEFAULTS)} />
        <div className="ml-auto self-end">
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4" /> Новое правило
          </Button>
        </div>
      </FilterBar>

      <div className="bg-card">
        <DataTable
          data={rows}
          columns={columns}
          rowKey={(r) => r.id}
          loading={rules.isLoading}
          error={rules.error}
          onRetry={() => rules.refetch()}
          onRowClick={openEdit}
          empty={
            <EmptyState
              icon={Filter}
              title="Правил пока нет"
              hint="Создайте правило, чтобы автоматически предлагать категорию/контрагента при импорте и вводе."
              action={
                <Button onClick={openCreate}>
                  <Plus className="h-4 w-4" /> Новое правило
                </Button>
              }
            />
          }
          mobileCards={(r) => (
            <div className="space-y-0.5">
              <div className="font-medium">{r.name}</div>
              <div className="text-xs text-muted-foreground">
                {r.conditions.map(describeCondition).join(' И ')}
              </div>
              <div className="text-xs text-muted-foreground">
                {r.actions.map(describeAction).join(', ')} · {APPLIES_TO_LABELS[r.appliesTo]}
                {r.appliedCount > 0 && ` · провело: ${r.appliedCount}`}
              </div>
            </div>
          )}
        />
      </div>

      <RuleFormDialog
        wsId={wsId}
        open={open}
        onClose={() => setOpen(false)}
        editing={editing}
        categories={categories.data ?? []}
        counterparties={counterparties.data ?? []}
        accounts={accounts.data ?? []}
        submitting={createMut.isPending || updateMut.isPending}
        onSubmit={async (input) => {
          if (editing) await updateMut.mutateAsync({ id: editing.id, ...input });
          else await createMut.mutateAsync(input);
          setOpen(false);
        }}
      />

      <ConfirmDialog
        open={!!delTarget}
        onOpenChange={(o) => !o && setDelTarget(null)}
        title={`Удалить правило «${delTarget?.name ?? ''}»?`}
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
