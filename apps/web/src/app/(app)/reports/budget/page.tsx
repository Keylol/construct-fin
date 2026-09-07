'use client';

import { Suspense, useMemo, useState } from 'react';
import { formatRub } from '@construct/shared';
import { ChevronLeft, ChevronRight, Plus, Tag, Trash2 } from '@/components/ui/icons';
import { Money } from '@/components/ui/Money';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { KpiCard } from '@/components/ui/KpiCard';
import { KpiRow } from '@/components/ui/KpiRow';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { FilterBar } from '@/components/ui/FilterBar';
import { FilterField } from '@/components/ui/FilterField';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { MoneyInput } from '@/components/ui/MoneyInput';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { toast } from '@/components/ui/Toaster';
import {
  Modal,
  ModalBody,
  ModalClose,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/Modal';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useUrlFilters } from '@/hooks/useUrlFilters';
import { flatCodec } from '@/lib/url-codec';
import { D } from '@construct/shared';
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

// Месяц живёт в адресе; пустое значение = текущий месяц (в адрес не пишется).
const DEFAULTS = { month: '' };
const CODEC = flatCodec(DEFAULTS);
const MONTH_RE = /^\d{4}-\d{2}$/;

// useSearchParams требует Suspense-границу на уровне page (Next 14 App Router).
export default function BudgetPage() {
  return (
    <Suspense>
      <BudgetView />
    </Suspense>
  );
}

function BudgetView() {
  const { current } = useCurrentWorkspace();
  const wsId = current?.id ?? null;
  const [filters, setFilters] = useUrlFilters(CODEC);
  const month = MONTH_RE.test(filters.month) ? filters.month : currentMonth();
  const setMonth = (next: string) => setFilters({ month: next === currentMonth() ? '' : next });
  const query = useBudgets(wsId, month);

  const [editing, setEditing] = useState<BudgetRow | null>(null);
  const [creating, setCreating] = useState(false);

  if (!current) return null;

  const r = query.data;
  const expenseRows = r?.rows.filter((row) => row.kind === 'EXPENSE') ?? [];
  const incomeRows = r?.rows.filter((row) => row.kind === 'INCOME') ?? [];

  return (
    <>
      <FilterBar>
        <FilterField label="Месяц">
          <div className="flex h-9 items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setMonth(shiftMonth(month, -1))}
              aria-label="Предыдущий месяц"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="min-w-[140px] text-center text-sm font-medium text-foreground">
              {monthTitle(month)}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setMonth(shiftMonth(month, 1))}
              aria-label="Следующий месяц"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </FilterField>
        {month !== currentMonth() && (
          <Button variant="ghost" size="sm" onClick={() => setFilters(DEFAULTS)} className="self-end">
            Текущий
          </Button>
        )}
        <div className="ml-auto self-end">
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> Лимит
          </Button>
        </div>
      </FilterBar>

      <div className="space-y-6 px-6 py-6">
      {query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : query.isLoading || !r ? (
        <KpiRow loading count={3}>
          {null}
        </KpiRow>
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
          <KpiRow count={3}>
            <KpiCard
              label="Расходы: факт / план"
              value={<PlanFact fact={r.totals.expenseFact} plan={r.totals.expensePlan} />}
              tone={D(r.totals.expenseFact).gt(r.totals.expensePlan) ? 'negative' : 'neutral'}
            />
            {D(r.totals.incomePlan).gt(0) && (
              <KpiCard
                label="Доходы: факт / план"
                value={<PlanFact fact={r.totals.incomeFact} plan={r.totals.incomePlan} />}
                tone={D(r.totals.incomeFact).gte(r.totals.incomePlan) ? 'positive' : 'neutral'}
              />
            )}
            <KpiCard
              label="Превышено лимитов"
              value={String(r.totals.overCount)}
              tone={r.totals.overCount > 0 ? 'negative' : 'positive'}
            />
          </KpiRow>

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
    </>
  );
}

/** «Факт / план» одной плиткой: факт — главная цифра, план — приглушённо. */
function PlanFact({ fact, plan }: { fact: string; plan: string }) {
  return (
    <>
      <Money value={fact} />
      <span className="text-base font-normal text-muted-foreground">
        {' '}
        / <Money value={plan} tone="plain" />
      </span>
    </>
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
  const columns: Column<BudgetRow>[] = [
    {
      key: 'category',
      header: 'Категория',
      cell: (row) => (
        <div className="min-w-0">
          <div className="truncate font-medium">{row.categoryName}</div>
          {row.note && <div className="truncate text-xs text-muted-foreground">{row.note}</div>}
        </div>
      ),
      className: 'w-full max-w-0',
    },
    {
      key: 'fact',
      header: 'Факт',
      align: 'right',
      cell: (row) => (
        <Money value={row.fact} className={cn(row.over && 'font-semibold text-destructive')} />
      ),
      className: 'w-[150px]',
    },
    {
      key: 'plan',
      header: 'План',
      align: 'right',
      cell: (row) => <Money value={row.amount} tone="plain" className="text-muted-foreground" />,
      className: 'w-[150px]',
    },
    {
      key: 'usage',
      header: 'Использовано',
      align: 'right',
      cell: (row) => <UsageBar row={row} />,
      className: 'w-[220px]',
    },
  ];
  const card = (row: BudgetRow) => (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-medium">{row.categoryName}</div>
          {row.note && <div className="truncate text-xs text-muted-foreground">{row.note}</div>}
        </div>
        <div className="shrink-0 text-right">
          <Money value={row.fact} className={cn('font-semibold', row.over && 'text-destructive')} />
          <div className="text-xs text-muted-foreground">из {formatRub(row.amount)}</div>
        </div>
      </div>
      <UsageBar row={row} />
    </div>
  );
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      <Card className="overflow-hidden !p-0">
        <DataTable
          data={rows}
          columns={columns}
          rowKey={(row) => row.id}
          onRowClick={onEdit}
          mobileCards={card}
        />
      </Card>
    </section>
  );
}

/** Полоса использования лимита: зелёный → янтарь (от 80%) → красный (>100%); доход — к цели. */
function UsageBar({ row }: { row: BudgetRow }) {
  const isExpense = row.kind === 'EXPENSE';
  const pct = Math.max(0, row.usagePct);
  const barWidth = Math.min(100, pct);
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
    <div className="flex items-center justify-end gap-2">
      <div className="h-1.5 w-full max-w-[140px] overflow-hidden rounded-full bg-border/60">
        <div className={cn('h-full rounded-full', barClass)} style={{ width: `${barWidth}%` }} />
      </div>
      <span
        className={cn(
          'w-11 shrink-0 text-right text-xs tabular-nums',
          row.over ? 'font-semibold text-destructive' : 'text-muted-foreground',
        )}
      >
        {row.usagePct}%
      </span>
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
    <Modal open onOpenChange={(o) => !o && onClose()} dirty={amount !== (editing?.amount ?? '') || note !== (editing?.note ?? '') || (!editing && !!categoryId)}>
      <ModalContent size="md" onConfirm={submit}>
        <ModalHeader>
          <ModalTitle>
            {editing ? `Лимит: ${editing.categoryName}` : 'Новый лимит по категории'}
          </ModalTitle>
        </ModalHeader>
        <ModalBody className="space-y-3">
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
        </ModalBody>
        <ModalFooter className={cn(editing && 'sm:justify-between')}>
          {editing && (
            <Button variant="destructive" onClick={() => setConfirmDel(true)}>
              <Trash2 className="h-4 w-4" /> Удалить
            </Button>
          )}
          <div className="flex gap-2">
            <ModalClose asChild>
              <Button variant="secondary">Отмена</Button>
            </ModalClose>
            <Button onClick={submit} disabled={!valid} loading={pending}>
              {editing ? 'Сохранить' : 'Задать'}
            </Button>
          </div>
        </ModalFooter>
      </ModalContent>
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
    </Modal>
  );
}
