'use client';

import { useEffect, useMemo, useState } from 'react';
import { Plus, Filter, X, Trash2, Pencil } from '@/components/ui/icons';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
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
import { useCounterparties } from '@/hooks/useCounterparties';
import { useAccounts } from '@/hooks/useAccounts';
import {
  useRules,
  useCreateRule,
  useUpdateRule,
  useDeleteRule,
  type CreateRuleInput,
} from '@/hooks/useRules';
import type {
  Rule,
  RuleAction,
  RuleActionType,
  RuleAppliesTo,
  RuleCondition,
  RuleConditionType,
  Account,
  Category,
  Counterparty,
} from '@/lib/types';

const CONDITION_LABELS: Record<RuleConditionType, string> = {
  DESCRIPTION_CONTAINS: 'Описание содержит',
  COUNTERPARTY_EQUALS: 'Контрагент — это',
  ACCOUNT_EQUALS: 'Счёт — это',
  TYPE_EQUALS: 'Тип операции',
  AMOUNT_RANGE: 'Сумма в диапазоне',
  SOURCE_EQUALS: 'Источник',
};

const ACTION_LABELS: Record<RuleActionType, string> = {
  SET_CATEGORY: 'Поставить категорию',
  SET_COUNTERPARTY: 'Поставить контрагента',
  SET_ACCOUNT: 'Поставить счёт',
};

const APPLIES_TO_LABELS: Record<RuleAppliesTo, string> = {
  IMPORT: 'Импорт',
  MANUAL: 'Ручной ввод',
  BOTH: 'Везде',
};

function defaultCondition(type: RuleConditionType): RuleCondition {
  switch (type) {
    case 'DESCRIPTION_CONTAINS':
      return { type, value: '' };
    case 'COUNTERPARTY_EQUALS':
      return { type, counterpartyId: '' };
    case 'ACCOUNT_EQUALS':
      return { type, accountId: '' };
    case 'TYPE_EQUALS':
      return { type, value: 'EXPENSE' };
    case 'AMOUNT_RANGE':
      return { type, min: '', max: '' };
    case 'SOURCE_EQUALS':
      return { type, value: 'IMPORT' };
  }
}

function defaultAction(type: RuleActionType): RuleAction {
  switch (type) {
    case 'SET_CATEGORY':
      return { type, categoryId: '' };
    case 'SET_COUNTERPARTY':
      return { type, counterpartyId: '' };
    case 'SET_ACCOUNT':
      return { type, accountId: '' };
  }
}

export default function RulesPage() {
  const ws = useCurrentWorkspace();
  const wsId = ws.currentId;
  const rules = useRules(wsId);
  const categories = useCategories(wsId);
  const counterparties = useCounterparties(wsId);
  const accounts = useAccounts(wsId);
  const createMut = useCreateRule(wsId ?? '');
  const updateMut = useUpdateRule(wsId ?? '');
  const deleteMut = useDeleteRule(wsId ?? '');

  const [editing, setEditing] = useState<Rule | null>(null);
  const [open, setOpen] = useState(false);
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
      cell: (r) => <Badge variant="outline">{APPLIES_TO_LABELS[r.appliesTo]}</Badge>,
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
      cell: (r) => (
        <label
          className="inline-flex items-center gap-2"
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={r.isActive}
            onChange={(e) => updateMut.mutate({ id: r.id, isActive: e.target.checked })}
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
            Правило срабатывает, когда выполнены <strong>все</strong> его условия, и
            подсказывает, что подставить — категорию, контрагента или счёт. Работает
            при импорте и/или ручном вводе; правило с большим приоритетом применяется
            первым. Ничего не двигает автоматически — вы подтверждаете подсказку.
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

function RuleFormDialog({
  wsId,
  open,
  onClose,
  editing,
  categories,
  counterparties,
  accounts,
  submitting,
  onSubmit,
}: {
  wsId: string;
  open: boolean;
  onClose: () => void;
  editing: Rule | null;
  categories: Category[];
  counterparties: Counterparty[];
  accounts: Account[];
  submitting: boolean;
  onSubmit: (input: CreateRuleInput) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [appliesTo, setAppliesTo] = useState<RuleAppliesTo>('BOTH');
  const [priority, setPriority] = useState(0);
  const [isActive, setIsActive] = useState(true);
  const [conditions, setConditions] = useState<RuleCondition[]>([
    { type: 'DESCRIPTION_CONTAINS', value: '' },
  ]);
  const [actions, setActions] = useState<RuleAction[]>([
    { type: 'SET_CATEGORY', categoryId: '' },
  ]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (editing) {
      setName(editing.name);
      setAppliesTo(editing.appliesTo);
      setPriority(editing.priority);
      setIsActive(editing.isActive);
      // Копии, чтобы правки формы не мутировали кэш query.
      setConditions(editing.conditions.map((c) => ({ ...c })));
      setActions(editing.actions.map((a) => ({ ...a })));
    } else {
      setName('');
      setAppliesTo('BOTH');
      setPriority(0);
      setIsActive(true);
      setConditions([{ type: 'DESCRIPTION_CONTAINS', value: '' }]);
      setActions([{ type: 'SET_CATEGORY', categoryId: '' }]);
    }
  }, [open, editing]);

  const activeAccounts = accounts.filter((a) => !a.isArchived);

  // Контрагенты для комбобокса — тот же паттерн, что в TransactionFormDialog:
  // вторичная строка = контакт, поиск находит и по нему.
  const counterpartyOptions = useMemo<ComboboxOption[]>(
    () =>
      counterparties
        .filter((c) => !c.isArchived)
        .map((c) => ({
          value: c.id,
          label: c.name,
          description: c.contact ?? undefined,
        })),
    [counterparties],
  );

  // Категории для комбобокса: иерархия через группы — заголовок = «kind ·
  // родитель», внутри «(общая)» + подкатегории. Здесь оба kind сразу (бывшие
  // optgroup «Расходы»/«Доходы»), поэтому kind вынесен в заголовок группы.
  const categoryOptions = useMemo<ComboboxOption[]>(() => {
    const active = categories.filter((c) => !c.isArchived);
    const forKind = (kind: 'INCOME' | 'EXPENSE', kindLabel: string) =>
      active
        .filter((c) => c.kind === kind && c.parentId === null)
        .flatMap((root) => [
          {
            value: root.id,
            label: `${root.name} (общая)`,
            group: `${kindLabel} · ${root.name}`,
          },
          ...active
            .filter((c) => c.parentId === root.id)
            .map((child) => ({
              value: child.id,
              label: child.name,
              group: `${kindLabel} · ${root.name}`,
            })),
        ]);
    return [...forKind('EXPENSE', 'Расходы'), ...forKind('INCOME', 'Доходы')];
  }, [categories]);

  function setCondition(i: number, c: RuleCondition) {
    setConditions((prev) => prev.map((x, idx) => (idx === i ? c : x)));
  }
  function setAction(i: number, a: RuleAction) {
    setActions((prev) => prev.map((x, idx) => (idx === i ? a : x)));
  }

  function validate(): string | null {
    if (!name.trim()) return 'Укажите название правила';
    if (conditions.length === 0) return 'Добавьте хотя бы одно условие';
    if (actions.length === 0) return 'Добавьте хотя бы одно действие';
    for (const c of conditions) {
      if (c.type === 'DESCRIPTION_CONTAINS' && !c.value.trim())
        return 'Заполните текст в условии «Описание содержит»';
      if (c.type === 'COUNTERPARTY_EQUALS' && !c.counterpartyId)
        return 'Выберите контрагента в условии';
      if (c.type === 'ACCOUNT_EQUALS' && !c.accountId) return 'Выберите счёт в условии';
      if (c.type === 'AMOUNT_RANGE') {
        const hasMin = c.min != null && c.min !== '';
        const hasMax = c.max != null && c.max !== '';
        if (!hasMin && !hasMax) return 'В диапазоне суммы укажите «от» или «до»';
        if (hasMin && Number.isNaN(Number(c.min))) return 'Сумма «от» указана некорректно';
        if (hasMax && Number.isNaN(Number(c.max))) return 'Сумма «до» указана некорректно';
        // Зеркалим серверную проверку (rule.dto.ts): сравнение по модулю, |от| ≤ |до|.
        // Ловим здесь, иначе пользователь получил бы невнятную 400 вместо подсказки.
        if (hasMin && hasMax && Math.abs(Number(c.min)) > Math.abs(Number(c.max)))
          return 'В диапазоне суммы: |от| должно быть ≤ |до|';
      }
    }
    for (const a of actions) {
      if (a.type === 'SET_CATEGORY' && !a.categoryId) return 'Выберите категорию в действии';
      if (a.type === 'SET_COUNTERPARTY' && !a.counterpartyId)
        return 'Выберите контрагента в действии';
      if (a.type === 'SET_ACCOUNT' && !a.accountId) return 'Выберите счёт в действии';
    }
    return null;
  }

  // Нормализация перед отправкой: пустые границы AMOUNT_RANGE → undefined.
  function normalizeConditions(): RuleCondition[] {
    return conditions.map((c) =>
      c.type === 'AMOUNT_RANGE'
        ? {
            type: 'AMOUNT_RANGE',
            min: c.min && c.min !== '' ? c.min : undefined,
            max: c.max && c.max !== '' ? c.max : undefined,
          }
        : c,
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const v = validate();
    if (v) {
      setError(v);
      return;
    }
    setError(null);
    try {
      await onSubmit({
        name: name.trim(),
        appliesTo,
        priority,
        isActive,
        conditions: normalizeConditions(),
        actions,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка сохранения');
    }
  }

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" hideClose size="xl">
        <SheetHeader className="flex-row items-center justify-between gap-2 space-y-0">
          <SheetTitle>{editing ? 'Изменить правило' : 'Новое правило'}</SheetTitle>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Закрыть">
            <X className="h-4 w-4" />
          </Button>
        </SheetHeader>
        <form className="flex min-h-0 flex-1 flex-col" noValidate onSubmit={handleSubmit}>
          <SheetBody className="space-y-5">
            <FormField label="Название" htmlFor="rule-name" required>
              <Input
                id="rule-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="например, «Продукты в офис»"
                required
              />
            </FormField>

            <div className="grid grid-cols-2 gap-3">
              <FormField label="Где применять" htmlFor="rule-applies">
                <Select
                  id="rule-applies"
                  value={appliesTo}
                  onChange={(e) => setAppliesTo(e.target.value as RuleAppliesTo)}
                >
                  <option value="BOTH">Везде</option>
                  <option value="IMPORT">Только импорт</option>
                  <option value="MANUAL">Только ручной ввод</option>
                </Select>
              </FormField>
              <FormField
                label="Приоритет"
                htmlFor="rule-priority"
                hint="Больше — срабатывает раньше."
              >
                <Input
                  id="rule-priority"
                  type="number"
                  min={0}
                  max={1000}
                  value={priority}
                  onChange={(e) => setPriority(Number(e.target.value))}
                />
              </FormField>
            </div>

            {/* ─── Условия (И) ─── */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Если (все условия)</span>
                <span className="text-xs text-muted-foreground">до 10</span>
              </div>
              {conditions.map((c, i) => (
                <ConditionRow
                  key={i}
                  wsId={wsId}
                  condition={c}
                  counterpartyOptions={counterpartyOptions}
                  accounts={activeAccounts}
                  onChange={(next) => setCondition(i, next)}
                  onRemove={
                    conditions.length > 1
                      ? () => setConditions((prev) => prev.filter((_, idx) => idx !== i))
                      : undefined
                  }
                />
              ))}
              {conditions.length < 10 && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    setConditions((prev) => [...prev, defaultCondition('DESCRIPTION_CONTAINS')])
                  }
                >
                  <Plus className="h-3.5 w-3.5" /> Условие
                </Button>
              )}
            </div>

            {/* ─── Действия ─── */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">То подставить</span>
                <span className="text-xs text-muted-foreground">до 5</span>
              </div>
              {actions.map((a, i) => (
                <ActionRow
                  key={i}
                  wsId={wsId}
                  action={a}
                  categoryOptions={categoryOptions}
                  counterpartyOptions={counterpartyOptions}
                  accounts={activeAccounts}
                  onChange={(next) => setAction(i, next)}
                  onRemove={
                    actions.length > 1
                      ? () => setActions((prev) => prev.filter((_, idx) => idx !== i))
                      : undefined
                  }
                />
              ))}
              {actions.length < 5 && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setActions((prev) => [...prev, defaultAction('SET_CATEGORY')])}
                >
                  <Plus className="h-3.5 w-3.5" /> Действие
                </Button>
              )}
            </div>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={isActive}
                onChange={(e) => setIsActive(e.target.checked)}
                className="h-4 w-4 rounded border-input accent-primary"
              />
              Активно
            </label>

            {error && <p className="text-sm text-destructive">{error}</p>}
          </SheetBody>
          <SheetFooter>
            <Button type="button" variant="secondary" onClick={onClose}>
              Отмена
            </Button>
            <Button type="submit" loading={submitting}>
              Сохранить
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}

function ConditionRow({
  wsId,
  condition,
  counterpartyOptions,
  accounts,
  onChange,
  onRemove,
}: {
  wsId: string;
  condition: RuleCondition;
  counterpartyOptions: ComboboxOption[];
  accounts: Account[];
  onChange: (c: RuleCondition) => void;
  onRemove?: () => void;
}) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-border bg-background p-2">
      <div className="flex-1 space-y-2">
        <Select
          value={condition.type}
          onChange={(e) => onChange(defaultCondition(e.target.value as RuleConditionType))}
          aria-label="Тип условия"
        >
          {(Object.keys(CONDITION_LABELS) as RuleConditionType[]).map((t) => (
            <option key={t} value={t}>
              {CONDITION_LABELS[t]}
            </option>
          ))}
        </Select>

        {condition.type === 'DESCRIPTION_CONTAINS' && (
          <Input
            value={condition.value}
            onChange={(e) => onChange({ type: 'DESCRIPTION_CONTAINS', value: e.target.value })}
            placeholder="подстрока в описании/контрагенте"
          />
        )}
        {condition.type === 'COUNTERPARTY_EQUALS' && (
          <Combobox
            value={condition.counterpartyId}
            onChange={(v) => onChange({ type: 'COUNTERPARTY_EQUALS', counterpartyId: v })}
            options={counterpartyOptions}
            placeholder="— Выберите контрагента —"
            searchPlaceholder="Имя или контакт…"
            recentKey={`${wsId}:counterparty`}
          />
        )}
        {condition.type === 'ACCOUNT_EQUALS' && (
          <Select
            value={condition.accountId}
            onChange={(e) => onChange({ type: 'ACCOUNT_EQUALS', accountId: e.target.value })}
          >
            <option value="" disabled>
              — Выберите счёт —
            </option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        )}
        {condition.type === 'TYPE_EQUALS' && (
          <Select
            value={condition.value}
            onChange={(e) =>
              onChange({ type: 'TYPE_EQUALS', value: e.target.value as 'INCOME' | 'EXPENSE' })
            }
          >
            <option value="EXPENSE">Расход</option>
            <option value="INCOME">Доход</option>
          </Select>
        )}
        {condition.type === 'AMOUNT_RANGE' && (
          <div className="grid grid-cols-2 gap-2">
            <Input
              inputMode="decimal"
              value={condition.min ?? ''}
              onChange={(e) =>
                onChange({ type: 'AMOUNT_RANGE', min: e.target.value, max: condition.max })
              }
              placeholder="от"
            />
            <Input
              inputMode="decimal"
              value={condition.max ?? ''}
              onChange={(e) =>
                onChange({ type: 'AMOUNT_RANGE', min: condition.min, max: e.target.value })
              }
              placeholder="до"
            />
          </div>
        )}
        {condition.type === 'SOURCE_EQUALS' && (
          <Select
            value={condition.value}
            onChange={(e) =>
              onChange({ type: 'SOURCE_EQUALS', value: e.target.value as 'IMPORT' | 'MANUAL' })
            }
          >
            <option value="IMPORT">Импорт</option>
            <option value="MANUAL">Ручной ввод</option>
          </Select>
        )}
      </div>
      {onRemove && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onRemove}
          aria-label="Убрать условие"
          className="text-muted-foreground"
        >
          <X className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}

function ActionRow({
  wsId,
  action,
  categoryOptions,
  counterpartyOptions,
  accounts,
  onChange,
  onRemove,
}: {
  wsId: string;
  action: RuleAction;
  categoryOptions: ComboboxOption[];
  counterpartyOptions: ComboboxOption[];
  accounts: Account[];
  onChange: (a: RuleAction) => void;
  onRemove?: () => void;
}) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-border bg-background p-2">
      <div className="flex-1 space-y-2">
        <Select
          value={action.type}
          onChange={(e) => onChange(defaultAction(e.target.value as RuleActionType))}
          aria-label="Тип действия"
        >
          {(Object.keys(ACTION_LABELS) as RuleActionType[]).map((t) => (
            <option key={t} value={t}>
              {ACTION_LABELS[t]}
            </option>
          ))}
        </Select>

        {action.type === 'SET_CATEGORY' && (
          <Combobox
            value={action.categoryId}
            onChange={(v) => onChange({ type: 'SET_CATEGORY', categoryId: v })}
            options={categoryOptions}
            placeholder="— Выберите категорию —"
            searchPlaceholder="Название категории…"
          />
        )}
        {action.type === 'SET_COUNTERPARTY' && (
          <Combobox
            value={action.counterpartyId}
            onChange={(v) => onChange({ type: 'SET_COUNTERPARTY', counterpartyId: v })}
            options={counterpartyOptions}
            placeholder="— Выберите контрагента —"
            searchPlaceholder="Имя или контакт…"
            recentKey={`${wsId}:counterparty`}
          />
        )}
        {action.type === 'SET_ACCOUNT' && (
          <Select
            value={action.accountId}
            onChange={(e) => onChange({ type: 'SET_ACCOUNT', accountId: e.target.value })}
          >
            <option value="" disabled>
              — Выберите счёт —
            </option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        )}
      </div>
      {onRemove && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onRemove}
          aria-label="Убрать действие"
          className="text-muted-foreground"
        >
          <X className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}
