'use client';

import { useEffect, useMemo, useState } from 'react';
import { Plus, X } from '@/components/ui/icons';
import { useRulePreview, type CreateRuleInput } from '@/hooks/useRules';
import type {
  Account,
  Category,
  Counterparty,
  Rule,
  RuleAction,
  RuleAppliesTo,
  RuleCondition,
  RulePreview,
} from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { FormField } from '@/components/ui/FormField';
import { type ComboboxOption } from '@/components/ui/Combobox';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/Modal';
import { ConditionRow } from './ConditionRow';
import { ActionRow } from './ActionRow';
import { PreviewPanel } from './PreviewPanel';
import { defaultAction, defaultCondition, isConditionFilled } from './dictionaries';

/** Modal-форма правила: условия (И) + действия + живой предпросмотр охвата. */
export function RuleFormDialog({
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
  const [preview, setPreview] = useState<RulePreview | null>(null);
  const requestPreview = useRulePreview(wsId);

  // Предпросмотр по мере правки условий: сработавшее правило сразу создаёт
  // проводки, поэтому охват надо видеть ДО сохранения, а не по факту.
  useEffect(() => {
    if (!open) return;
    const ready = conditions.filter(isConditionFilled);
    if (ready.length === 0) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      requestPreview(ready)
        .then((r) => {
          if (!cancelled) setPreview(r);
        })
        // Предпросмотр — подсказка, а не часть сохранения: молча гаснет.
        .catch(() => {
          if (!cancelled) setPreview(null);
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [open, conditions, requestPreview]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setPreview(null);
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
      if (c.type === 'COUNTERPARTY_INN_IN') {
        if (c.values.length === 0) return 'Укажите хотя бы один ИНН';
        // Зеркалим серверную проверку: ИНН — 10 цифр (организация) или 12 (ИП).
        const bad = c.values.find((v) => v.length !== 10 && v.length !== 12);
        if (bad) return `ИНН «${bad}» — нужно 10 цифр (организация) или 12 (ИП)`;
      }
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
    <Modal open={open} onOpenChange={(o) => !o && onClose()}>
      <ModalContent hideClose size="xl">
        <ModalHeader className="flex-row items-center justify-between gap-2 space-y-0">
          <ModalTitle>{editing ? 'Изменить правило' : 'Новое правило'}</ModalTitle>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Закрыть">
            <X className="h-4 w-4" />
          </Button>
        </ModalHeader>
        <form className="flex min-h-0 flex-1 flex-col" noValidate onSubmit={handleSubmit}>
          <ModalBody className="space-y-5">
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

              {preview && <PreviewPanel preview={preview} />}
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
          </ModalBody>
          <ModalFooter>
            <Button type="button" variant="secondary" onClick={onClose}>
              Отмена
            </Button>
            <Button type="submit" loading={submitting}>
              Сохранить
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}
