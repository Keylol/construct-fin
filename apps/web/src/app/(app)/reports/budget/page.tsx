'use client';

import { useMemo, useState } from 'react';
import { formatRub } from '@construct/shared';
import { ChevronLeft, ChevronRight, Pencil, Plus, Tag, Trash2 } from '@/components/ui/icons';
import { Money } from '@/components/ui/Money';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { KpiCard } from '@/components/ui/KpiCard';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { Skeleton } from '@/components/ui/Skeleton';
import { MoneyInput } from '@/components/ui/MoneyInput';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { toast } from '@/components/ui/Toaster';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useCategories } from '@/hooks/useCategories';
import {
  useBudgets,
  useCreateBudget,
  useDeleteBudget,
  useUpdateBudget,
} from '@/hooks/useBudgets';
import type { BudgetRow } from '@/lib/types';
import { cn } from '@/lib/cn';
import { MONTH_NAMES } from '@/lib/labels';

/**
 * Бюджет план/факт: месячные лимиты расходов (и планы доходов) по категориям.
 * Лимит действует каждый месяц; факт — операции категории и её подкатегорий
 * за выбранный месяц. Превышение подсвечивается.
 */


function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y!, m! - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function monthTitle(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return `${MONTH_NAMES[(m ?? 1) - 1]} ${y}`;
}

export default function BudgetPage() {
  const { current } = useCurrentWorkspace();
  const wsId = current?.id ?? null;
  const [month, setMonth] = useState(currentMonth());
  const query = useBudgets(wsId, month);

  const [editing, setEditing] = useState<BudgetRow | null>(null);
  const [creating, setCreating] = useState(false);

  if (!current) return null;

  const r = query.data;
  const expenseRows = r?.rows.filter((row) => row.kind === 'EXPENSE') ?? [];
  const incomeRows = r?.rows.filter((row) => row.kind === 'INCOME') ?? [];

  return (
    <div className="space-y-6 px-6 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setMonth((m) => shiftMonth(m, -1))}
            aria-label="Предыдущий месяц"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="min-w-[150px] text-center text-sm font-semibold">
            {monthTitle(month)}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setMonth((m) => shiftMonth(m, 1))}
            aria-label="Следующий месяц"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          {month !== currentMonth() && (
            <Button variant="link" size="sm" onClick={() => setMonth(currentMonth())}>
              Текущий
            </Button>
          )}
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" /> Лимит
        </Button>
      </div>

      {query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : query.isLoading || !r ? (
        <Skeleton className="h-64" />
      ) : r.rows.length === 0 ? (
        <EmptyState
          icon={Tag}
          title="Бюджет не настроен"
          hint="Задайте месячные лимиты по категориям расходов — факт будет сверяться автоматически. Можно добавить и план по доходным категориям."
          action={
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" /> Задать первый лимит
            </Button>
          }
        />
      ) : (
        <>
          {/* Итоги месяца */}
          <div className="grid gap-4 sm:grid-cols-3">
            <KpiCard
              label="Расходы: факт / план"
              value={`${formatRub(r.totals.expenseFact)} / ${formatRub(r.totals.expensePlan)}`}
              tone={Number(r.totals.expenseFact) > Number(r.totals.expensePlan) ? 'negative' : 'neutral'}
            />
            {Number(r.totals.incomePlan) > 0 && (
              <KpiCard
                label="Доходы: факт / план"
                value={`${formatRub(r.totals.incomeFact)} / ${formatRub(r.totals.incomePlan)}`}
                tone={
                  Number(r.totals.incomeFact) >= Number(r.totals.incomePlan)
                    ? 'positive'
                    : 'neutral'
                }
              />
            )}
            <KpiCard
              label="Превышено лимитов"
              value={String(r.totals.overCount)}
              tone={r.totals.overCount > 0 ? 'negative' : 'positive'}
            />
          </div>

          {expenseRows.length > 0 && (
            <BudgetSection
              title="Лимиты расходов"
              rows={expenseRows}
              onEdit={setEditing}
            />
          )}
          {incomeRows.length > 0 && (
            <BudgetSection title="Планы доходов" rows={incomeRows} onEdit={setEditing} />
          )}

          <p className="text-xs text-muted-foreground">
            Лимит действует каждый месяц, факт — операции категории и её подкатегорий за{' '}
            {monthTitle(r.month).toLowerCase()}. Возвраты уменьшают факт.
          </p>
        </>
      )}

      {(creating || editing) && (
        <BudgetDialog
          wsId={current.id}
          editing={editing}
          existingCategoryIds={(r?.rows ?? []).map((row) => row.categoryId)}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function BudgetSection({
  title,
  rows,
  onEdit,
}: {
  title: string;
  rows: BudgetRow[];
  onEdit: (row: BudgetRow) => void;
}) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      <Card className="divide-y divide-border/60 p-0">
        {rows.map((row) => (
          <BudgetRowView key={row.id} row={row} onEdit={() => onEdit(row)} />
        ))}
      </Card>
    </section>
  );
}

function BudgetRowView({ row, onEdit }: { row: BudgetRow; onEdit: () => void }) {
  const isExpense = row.kind === 'EXPENSE';
  const pct = Math.max(0, row.usagePct);
  const barWidth = Math.min(100, pct);
  // Расход: зелёный → янтарь (от 80%) → красный (>100%). Доход: к цели, зелёный от 100%.
  const barClass = isExpense
    ? row.over
      ? 'bg-destructive'
      : pct >= 80
        ? 'bg-warning'
        : 'bg-success'
    : pct >= 100
      ? 'bg-success'
      : 'bg-primary/50';

  return (
    <div className="space-y-1.5 px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0 truncate text-sm font-medium text-foreground">
          {row.categoryName}
          {row.note && (
            <span className="ml-2 text-xs font-normal text-muted-foreground">{row.note}</span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className={cn('num text-sm', row.over && 'font-semibold text-destructive')}>
            <Money value={row.fact} />
          </span>
          <span className="text-xs text-muted-foreground">/ {formatRub(row.amount)}</span>
          <span
            className={cn(
              'rounded-full px-1.5 py-0.5 text-[11px] font-medium tabular-nums',
              row.over
                ? 'bg-destructive/15 text-destructive'
                : 'bg-secondary text-muted-foreground',
            )}
          >
            {row.usagePct}%
          </span>
          <Button variant="ghost" size="sm" onClick={onEdit} aria-label="Изменить">
            <Pencil className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-border/60">
        <div className={cn('h-full rounded-full', barClass)} style={{ width: `${barWidth}%` }} />
      </div>
    </div>
  );
}

function BudgetDialog({
  wsId,
  editing,
  existingCategoryIds,
  onClose,
}: {
  wsId: string;
  editing: BudgetRow | null;
  existingCategoryIds: string[];
  onClose: () => void;
}) {
  const expenseCats = useCategories(wsId, 'EXPENSE');
  const incomeCats = useCategories(wsId, 'INCOME');
  const create = useCreateBudget(wsId);
  const update = useUpdateBudget(wsId);
  const del = useDeleteBudget(wsId);

  const [categoryId, setCategoryId] = useState(editing?.categoryId ?? '');
  const [amount, setAmount] = useState(editing?.amount ?? '');
  const [note, setNote] = useState(editing?.note ?? '');
  const [confirmDel, setConfirmDel] = useState(false);

  // Категории без уже заданного бюджета (при создании); расходы вперёд.
  const options = useMemo<ComboboxOption[]>(() => {
    const taken = new Set(existingCategoryIds);
    const list = [
      ...(expenseCats.data ?? []).map((c) => ({ c, kindLabel: 'Расход' })),
      ...(incomeCats.data ?? []).map((c) => ({ c, kindLabel: 'Доход' })),
    ];
    return list
      .filter(({ c }) => !taken.has(c.id))
      .map(({ c, kindLabel }) => ({
        value: c.id,
        label: c.name,
        description: kindLabel,
      }));
  }, [expenseCats.data, incomeCats.data, existingCategoryIds]);

  const valid =
    (!!editing || !!categoryId) && /^\d+(\.\d{1,2})?$/.test(amount) && Number(amount) > 0;
  const pending = create.isPending || update.isPending;

  const submit = () => {
    if (!valid) return;
    const done = {
      onSuccess: () => {
        toast.success(editing ? 'Лимит обновлён' : 'Лимит задан');
        onClose();
      },
      onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Не удалось сохранить'),
    };
    if (editing) {
      update.mutate({ id: editing.id, amount, note: note.trim() || null }, done);
    } else {
      create.mutate({ categoryId, amount, note: note.trim() || null }, done);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[420px]">
        <DialogHeader>
          <DialogTitle>
            {editing ? `Лимит: ${editing.categoryName}` : 'Новый лимит по категории'}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          {!editing && (
            <FormField label="Категория" required>
              <Combobox
                value={categoryId}
                onChange={setCategoryId}
                options={options}
                placeholder="Выберите категорию"
                searchPlaceholder="Категория…"
                className="h-9"
              />
            </FormField>
          )}
          <FormField
            label="Сумма в месяц"
            required
            hint="Для расходной категории — лимит, для доходной — план"
          >
            <MoneyInput value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
          </FormField>
          <FormField label="Заметка">
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="необязательно" />
          </FormField>
        </div>
        <DialogFooter className={cn(editing && 'sm:justify-between')}>
          {editing && (
            <Button variant="destructive" onClick={() => setConfirmDel(true)}>
              <Trash2 className="h-4 w-4" /> Удалить
            </Button>
          )}
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>
              Отмена
            </Button>
            <Button onClick={submit} disabled={!valid} loading={pending}>
              {editing ? 'Сохранить' : 'Задать'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
      {editing && (
        <ConfirmDialog
          open={confirmDel}
          onOpenChange={setConfirmDel}
          title="Удалить лимит?"
          description="История операций не пострадает — исчезнет только строка бюджета."
          confirmText="Удалить"
          variant="destructive"
          onConfirm={async () => {
            await del.mutateAsync(editing.id);
            toast.success('Лимит удалён');
            onClose();
          }}
        />
      )}
    </Dialog>
  );
}
