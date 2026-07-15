'use client';

import { useMemo, useState } from 'react';
import { formatRub } from '@construct/shared';
import { Calendar, Repeat, Plus, Pencil, Trash2, Check, RotateCcw } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { MoneyInput } from '@/components/ui/MoneyInput';
import { FormField } from '@/components/ui/FormField';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
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
import { QuickCreateCounterpartyDialog } from '@/components/counterparties/QuickCreateCounterpartyDialog';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useAccounts } from '@/hooks/useAccounts';
import { useCategories } from '@/hooks/useCategories';
import { useCounterparties } from '@/hooks/useCounterparties';
import {
  useRecurring,
  useUpcoming,
  usePlannedList,
  useCreateRecurring,
  useUpdateRecurring,
  useDeleteRecurring,
  useCreatePlanned,
  useUpdatePlanned,
  useSetPlannedStatus,
  usePayPlanned,
  useRevertPlanned,
} from '@/hooks/usePlanning';
import type {
  PlannedPayment,
  PlannedTxKind,
  RecurrenceCadence,
  RecurringPayment,
} from '@/lib/types';
import { formatDate } from '@/lib/dates';
import { cn } from '@/lib/cn';

const TX_KIND_LABEL: Record<PlannedTxKind, string> = {
  FIXED_COST: 'Постоянные',
  VARIABLE_COST: 'Переменные',
  SALARY: 'Зарплата',
  TAX: 'Налог',
  NON_OP: 'Внереализационные',
  OTHER: 'Прочее',
};
const TX_KINDS: PlannedTxKind[] = ['FIXED_COST', 'VARIABLE_COST', 'SALARY', 'TAX', 'NON_OP', 'OTHER'];
const WEEKDAYS = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];

/** «через N дней» / «сегодня» / «просрочено N дн» словами. */
function dueLabel(p: PlannedPayment): string {
  if (p.dueInDays === 0) return 'сегодня';
  if (p.dueInDays < 0) return `просрочено ${Math.abs(p.dueInDays)} дн.`;
  return `через ${p.dueInDays} дн.`;
}
function dueChipClass(p: PlannedPayment): string {
  if (p.overdue) return 'bg-destructive/15 text-destructive';
  if (p.soon) return 'bg-warning/15 text-warning';
  return 'bg-secondary text-muted-foreground';
}

/** Человекочитаемый график регулярного платежа. */
function scheduleLabel(r: RecurringPayment): string {
  if (r.cadence === 'MONTHLY') return `Ежемесячно, ${r.dayOfMonth}-го числа`;
  return `Еженедельно, ${WEEKDAYS[r.weekday ?? 0]}`;
}

const todayISODate = () => new Date().toISOString().slice(0, 10);
/** Дата из <input type=date> в ISO-инстант на полдень бизнес-дня (стабильно). */
const dateToNoonIso = (d: string) => new Date(`${d}T12:00:00.000Z`).toISOString();

export default function PlanningPage() {
  const { current } = useCurrentWorkspace();
  const wsId = current?.id ?? null;
  const upcoming = useUpcoming(wsId, 60);
  const recurring = useRecurring(wsId);
  const paidList = usePlannedList(wsId, { status: 'PAID' });

  const [recurringDialog, setRecurringDialog] = useState<{ editing: RecurringPayment | null } | null>(null);
  const [plannedDialog, setPlannedDialog] = useState<{ mode: 'manual' | 'salary'; editing: PlannedPayment | null } | null>(null);
  const [payFor, setPayFor] = useState<PlannedPayment | null>(null);

  if (!current) {
    return (
      <>
        <PageHeader title="Платежи" />
        <div className="p-6">
          <EmptyState icon={Calendar} title="Нет активного пространства" hint="Выберите пространство." />
        </div>
      </>
    );
  }

  const up = upcoming.data;

  return (
    <>
      <PageHeader
        title="Платежи"
        breadcrumbs={[{ label: 'Платежи' }]}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => setPlannedDialog({ mode: 'salary', editing: null })}>
              <Plus className="h-4 w-4" /> Зарплата
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setPlannedDialog({ mode: 'manual', editing: null })}>
              <Plus className="h-4 w-4" /> Разовый
            </Button>
            <Button size="sm" onClick={() => setRecurringDialog({ editing: null })}>
              <Repeat className="h-4 w-4" /> Регулярный
            </Button>
          </div>
        }
      />

      <div className="space-y-6 px-6 py-4">
        <p className="max-w-3xl text-sm text-muted-foreground">
          Ожидаемые оттоки: регулярные платежи (аренда, подписки) генерируются сами,
          зарплаты и разовые вносятся вручную. Отметка «Оплатить» кладёт обычную
          операцию на счёт — план связывается с фактом. Всё редактируется здесь.
        </p>

        {/* Сводка «горит» */}
        {up && (up.overdueCount > 0 || up.soonCount > 0) && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <SummaryCard
              label="Просрочено"
              count={up.overdueCount}
              sum={up.overdueSum}
              tone="destructive"
            />
            <SummaryCard label="Скоро" count={up.soonCount} sum={up.soonSum} tone="warning" />
          </div>
        )}

        {/* Ближайшие платежи */}
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-foreground">Ближайшие платежи</h2>
          {upcoming.isLoading ? (
            <Skeleton className="h-40" />
          ) : !up || up.items.length === 0 ? (
            <EmptyState
              icon={Calendar}
              title="Нет предстоящих платежей"
              hint="Добавьте регулярный, разовый платёж или выплату зарплаты."
            />
          ) : (
            <Card className="divide-y divide-border/60 p-0">
              {up.items.map((p) => (
                <PlannedRow
                  key={p.id}
                  p={p}
                  onPay={() => setPayFor(p)}
                  onEdit={
                    p.source !== 'RECURRING'
                      ? () => setPlannedDialog({ mode: p.source === 'SALARY' ? 'salary' : 'manual', editing: p })
                      : undefined
                  }
                  wsId={current.id}
                />
              ))}
            </Card>
          )}
        </section>

        {/* Регулярные платежи */}
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-foreground">Регулярные платежи</h2>
          {recurring.isLoading ? (
            <Skeleton className="h-24" />
          ) : (recurring.data?.length ?? 0) === 0 ? (
            <EmptyState
              icon={Repeat}
              title="Пока нет регулярных платежей"
              hint="Аренда, интернет, подписки — добавьте шаблон, и позиции появятся сами."
            />
          ) : (
            <Card className="divide-y divide-border/60 p-0">
              {recurring.data!.map((r) => (
                <RecurringRow
                  key={r.id}
                  r={r}
                  wsId={current.id}
                  onEdit={() => setRecurringDialog({ editing: r })}
                />
              ))}
            </Card>
          )}
        </section>

        {/* Оплаченные — с возможностью отмены (корректировка) */}
        {(paidList.data?.length ?? 0) > 0 && (
          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-muted-foreground">Оплаченные</h2>
            <Card className="divide-y divide-border/60 p-0">
              {paidList.data!.map((p) => (
                <PaidRow key={p.id} p={p} wsId={current.id} />
              ))}
            </Card>
          </section>
        )}
      </div>

      {recurringDialog && (
        <RecurringDialog
          wsId={current.id}
          editing={recurringDialog.editing}
          onClose={() => setRecurringDialog(null)}
        />
      )}
      {plannedDialog && (
        <PlannedDialog
          wsId={current.id}
          mode={plannedDialog.mode}
          editing={plannedDialog.editing}
          onClose={() => setPlannedDialog(null)}
        />
      )}
      {payFor && <PayDialog wsId={current.id} plan={payFor} onClose={() => setPayFor(null)} />}
    </>
  );
}

function SummaryCard({
  label,
  count,
  sum,
  tone,
}: {
  label: string;
  count: number;
  sum: string;
  tone: 'destructive' | 'warning';
}) {
  return (
    <Card className={cn('flex items-center justify-between p-4', tone === 'destructive' ? 'border-destructive/30' : 'border-warning/30')}>
      <div>
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="text-sm text-muted-foreground">{count} платеж(ей)</div>
      </div>
      <div className={cn('text-xl font-semibold tabular-nums', tone === 'destructive' ? 'text-destructive' : 'text-warning')}>
        {formatRub(sum, 2)}
      </div>
    </Card>
  );
}

function PlannedRow({
  p,
  onPay,
  onEdit,
  wsId,
}: {
  p: PlannedPayment;
  onPay: () => void;
  onEdit?: () => void;
  wsId: string;
}) {
  const setStatus = useSetPlannedStatus(wsId);
  const subtitle = [
    p.source === 'SALARY' ? 'Зарплата' : p.recurringTitle ? 'Регулярный' : 'Разовый',
    p.counterpartyName,
    p.categoryName,
  ]
    .filter(Boolean)
    .join(' · ');

  const skip = () =>
    setStatus.mutate(
      { id: p.id, status: 'SKIPPED' },
      { onSuccess: () => toast.success('Платёж пропущен'), onError: (e) => toast.error(e instanceof Error ? e.message : 'Ошибка') },
    );

  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3">
      <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium', dueChipClass(p))}>
        {dueLabel(p)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">{p.title}</div>
        <div className="truncate text-xs text-muted-foreground">
          {formatDate(p.dueDate)}
          {subtitle && ` · ${subtitle}`}
        </div>
      </div>
      <div className="text-right text-sm font-semibold tabular-nums">{formatRub(p.amount, 2)}</div>
      <div className="flex shrink-0 items-center gap-1">
        <Button size="sm" onClick={onPay}>
          <Check className="h-4 w-4" /> Оплатить
        </Button>
        {onEdit && (
          <Button variant="ghost" size="sm" onClick={onEdit} aria-label="Править">
            <Pencil className="h-4 w-4" />
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={skip} disabled={setStatus.isPending} aria-label="Пропустить">
          ✕
        </Button>
      </div>
    </div>
  );
}

function RecurringRow({ r, wsId, onEdit }: { r: RecurringPayment; wsId: string; onEdit: () => void }) {
  const update = useUpdateRecurring(wsId);
  const del = useDeleteRecurring(wsId);
  const [confirmDel, setConfirmDel] = useState(false);

  const toggleActive = () =>
    update.mutate(
      { id: r.id, isActive: !r.isActive },
      { onError: (e) => toast.error(e instanceof Error ? e.message : 'Ошибка') },
    );

  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{r.title}</span>
          {!r.isActive && (
            <span className="rounded-full bg-secondary px-2 py-0.5 text-[11px] text-muted-foreground">пауза</span>
          )}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {scheduleLabel(r)} · {TX_KIND_LABEL[r.txKind]}
          {r.nextDueDate && r.isActive && ` · след. ${formatDate(r.nextDueDate)}`}
        </div>
      </div>
      <div className="text-right text-sm font-semibold tabular-nums">{formatRub(r.amount, 2)}</div>
      <div className="flex shrink-0 items-center gap-1">
        <Button variant="ghost" size="sm" onClick={toggleActive} disabled={update.isPending}>
          {r.isActive ? 'Пауза' : 'Включить'}
        </Button>
        <Button variant="ghost" size="sm" onClick={onEdit} aria-label="Править">
          <Pencil className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setConfirmDel(true)} aria-label="Удалить">
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      <ConfirmDialog
        open={confirmDel}
        onOpenChange={setConfirmDel}
        title="Удалить регулярный платёж?"
        description="Будущие ожидаемые позиции этого правила будут отменены. Уже оплаченные останутся."
        confirmText="Удалить"
        onConfirm={async () => {
          await del.mutateAsync(r.id);
          toast.success('Регулярный платёж удалён');
        }}
      />
    </div>
  );
}

function PaidRow({ p, wsId }: { p: PlannedPayment; wsId: string }) {
  const revert = useRevertPlanned(wsId);
  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-foreground">{p.title}</div>
        <div className="truncate text-xs text-muted-foreground">{formatDate(p.dueDate)}</div>
      </div>
      <div className="text-right text-sm tabular-nums text-muted-foreground">{formatRub(p.amount, 2)}</div>
      <Button
        variant="ghost"
        size="sm"
        onClick={() =>
          revert.mutate(p.id, {
            onSuccess: () => toast.success('Оплата отменена'),
            onError: (e) => toast.error(e instanceof Error ? e.message : 'Ошибка'),
          })
        }
        disabled={revert.isPending}
      >
        <RotateCcw className="h-4 w-4" /> Отменить оплату
      </Button>
    </div>
  );
}

// ───────────────────────── Диалоги ─────────────────────────

function RecurringDialog({
  wsId,
  editing,
  onClose,
}: {
  wsId: string;
  editing: RecurringPayment | null;
  onClose: () => void;
}) {
  const accounts = useAccounts(wsId);
  const categories = useCategories(wsId, 'EXPENSE');
  const create = useCreateRecurring(wsId);
  const update = useUpdateRecurring(wsId);

  const [title, setTitle] = useState(editing?.title ?? '');
  const [amount, setAmount] = useState(editing?.amount ?? '');
  const [txKind, setTxKind] = useState<PlannedTxKind>(editing?.txKind ?? 'FIXED_COST');
  const [cadence, setCadence] = useState<RecurrenceCadence>(editing?.cadence ?? 'MONTHLY');
  const [dayOfMonth, setDayOfMonth] = useState(String(editing?.dayOfMonth ?? 1));
  const [weekday, setWeekday] = useState(String(editing?.weekday ?? 1));
  const [startDate, setStartDate] = useState(editing?.startDate.slice(0, 10) ?? todayISODate());
  const [leadDays, setLeadDays] = useState(String(editing?.leadDays ?? 3));
  const [accountId, setAccountId] = useState(editing?.accountId ?? '');
  const [categoryId, setCategoryId] = useState(editing?.categoryId ?? '');
  const [note, setNote] = useState(editing?.note ?? '');

  const accountOptions = useMemo<ComboboxOption[]>(
    () => (accounts.data ?? []).map((a) => ({ value: a.id, label: a.name })),
    [accounts.data],
  );
  const categoryOptions = useMemo<ComboboxOption[]>(
    () => (categories.data ?? []).map((c) => ({ value: c.id, label: c.name })),
    [categories.data],
  );

  const valid = title.trim() !== '' && /^\d+(\.\d{1,2})?$/.test(amount) && Number(amount) > 0;
  const pending = create.isPending || update.isPending;

  const submit = () => {
    if (!valid) return;
    const payload = {
      title: title.trim(),
      amount,
      txKind,
      cadence,
      dayOfMonth: cadence === 'MONTHLY' ? Number(dayOfMonth) : null,
      weekday: cadence === 'WEEKLY' ? Number(weekday) : null,
      startDate: dateToNoonIso(startDate),
      leadDays: Number(leadDays),
      accountId: accountId || null,
      categoryId: categoryId || null,
      note: note.trim() || null,
    };
    const done = {
      onSuccess: () => {
        toast.success(editing ? 'Регулярный платёж обновлён' : 'Регулярный платёж создан');
        onClose();
      },
      onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Не удалось сохранить'),
    };
    if (editing) update.mutate({ id: editing.id, ...payload }, done);
    else create.mutate(payload, done);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[460px]">
        <DialogHeader>
          <DialogTitle>{editing ? 'Регулярный платёж' : 'Новый регулярный платёж'}</DialogTitle>
        </DialogHeader>
        <div className="max-h-[70vh] space-y-3 overflow-y-auto py-2">
          <FormField label="Название" required>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Аренда офиса" autoFocus />
          </FormField>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Сумма" required>
              <MoneyInput value={amount} onChange={(e) => setAmount(e.target.value)} />
            </FormField>
            <FormField label="Статья">
              <Select value={txKind} onChange={(e) => setTxKind(e.target.value as PlannedTxKind)}>
                {TX_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {TX_KIND_LABEL[k]}
                  </option>
                ))}
              </Select>
            </FormField>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Периодичность">
              <Select value={cadence} onChange={(e) => setCadence(e.target.value as RecurrenceCadence)}>
                <option value="MONTHLY">Ежемесячно</option>
                <option value="WEEKLY">Еженедельно</option>
              </Select>
            </FormField>
            {cadence === 'MONTHLY' ? (
              <FormField label="Число месяца" hint="1–31, лишнее подтянется к концу месяца">
                <Input type="number" min={1} max={31} value={dayOfMonth} onChange={(e) => setDayOfMonth(e.target.value)} />
              </FormField>
            ) : (
              <FormField label="День недели">
                <Select value={weekday} onChange={(e) => setWeekday(e.target.value)}>
                  {WEEKDAYS.map((w, i) => (
                    <option key={i} value={i}>
                      {w}
                    </option>
                  ))}
                </Select>
              </FormField>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Активно с">
              <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </FormField>
            <FormField label="Напомнить за (дней)">
              <Input type="number" min={0} max={60} value={leadDays} onChange={(e) => setLeadDays(e.target.value)} />
            </FormField>
          </div>
          <FormField label="Счёт списания (по умолчанию)">
            <Combobox
              value={accountId}
              onChange={setAccountId}
              options={accountOptions}
              placeholder="Не выбран"
              searchPlaceholder="Счёт…"
              className="h-9"
            />
          </FormField>
          <FormField label="Категория">
            <Combobox
              value={categoryId}
              onChange={setCategoryId}
              options={categoryOptions}
              placeholder="Не выбрана"
              searchPlaceholder="Категория…"
              className="h-9"
            />
          </FormField>
          <FormField label="Заметка">
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
          </FormField>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Отмена
          </Button>
          <Button onClick={submit} disabled={!valid} loading={pending}>
            {editing ? 'Сохранить' : 'Создать'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PlannedDialog({
  wsId,
  mode,
  editing,
  onClose,
}: {
  wsId: string;
  mode: 'manual' | 'salary';
  editing: PlannedPayment | null;
  onClose: () => void;
}) {
  const isSalary = mode === 'salary';
  const accounts = useAccounts(wsId);
  const categories = useCategories(wsId, 'EXPENSE');
  const employees = useCounterparties(wsId, undefined, false, 'EMPLOYEE');
  const create = useCreatePlanned(wsId);
  const update = useUpdatePlanned(wsId);

  const [title, setTitle] = useState(editing?.title ?? '');
  const [amount, setAmount] = useState(editing?.amount ?? '');
  const [txKind, setTxKind] = useState<PlannedTxKind>(editing?.txKind ?? (isSalary ? 'SALARY' : 'FIXED_COST'));
  const [dueDate, setDueDate] = useState(editing?.dueDate.slice(0, 10) ?? todayISODate());
  const [leadDays, setLeadDays] = useState(String(editing?.leadDays ?? 3));
  const [accountId, setAccountId] = useState(editing?.accountId ?? '');
  const [categoryId, setCategoryId] = useState(editing?.categoryId ?? '');
  const [counterpartyId, setCounterpartyId] = useState(editing?.counterpartyId ?? '');
  const [note, setNote] = useState(editing?.note ?? '');
  const [quickEmp, setQuickEmp] = useState<{ open: boolean; name: string }>({ open: false, name: '' });

  const accountOptions = useMemo<ComboboxOption[]>(
    () => (accounts.data ?? []).map((a) => ({ value: a.id, label: a.name })),
    [accounts.data],
  );
  const categoryOptions = useMemo<ComboboxOption[]>(
    () => (categories.data ?? []).map((c) => ({ value: c.id, label: c.name })),
    [categories.data],
  );
  const employeeOptions = useMemo<ComboboxOption[]>(
    () => (employees.data ?? []).map((e) => ({ value: e.id, label: e.name })),
    [employees.data],
  );

  const valid =
    title.trim() !== '' &&
    /^\d+(\.\d{1,2})?$/.test(amount) &&
    Number(amount) > 0 &&
    (!isSalary || !!counterpartyId);
  const pending = create.isPending || update.isPending;

  const submit = () => {
    if (!valid) return;
    const done = {
      onSuccess: () => {
        toast.success(editing ? 'Платёж обновлён' : 'Платёж запланирован');
        onClose();
      },
      onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Не удалось сохранить'),
    };
    if (editing) {
      update.mutate(
        {
          id: editing.id,
          title: title.trim(),
          amount,
          txKind,
          dueDate: dateToNoonIso(dueDate),
          leadDays: Number(leadDays),
          accountId: accountId || null,
          categoryId: categoryId || null,
          counterpartyId: counterpartyId || null,
          note: note.trim() || null,
        },
        done,
      );
    } else {
      create.mutate(
        {
          title: title.trim(),
          amount,
          txKind: isSalary ? 'SALARY' : txKind,
          dueDate: dateToNoonIso(dueDate),
          source: isSalary ? 'SALARY' : 'MANUAL',
          leadDays: Number(leadDays),
          accountId: accountId || null,
          categoryId: categoryId || null,
          counterpartyId: counterpartyId || null,
          note: note.trim() || null,
        },
        done,
      );
    }
  };

  const heading = editing
    ? isSalary
      ? 'Выплата зарплаты'
      : 'Плановый платёж'
    : isSalary
      ? 'Новая выплата зарплаты'
      : 'Новый разовый платёж';

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[440px]">
        <DialogHeader>
          <DialogTitle>{heading}</DialogTitle>
        </DialogHeader>
        <div className="max-h-[70vh] space-y-3 overflow-y-auto py-2">
          {isSalary && (
            <FormField label="Сотрудник" required>
              <Combobox
                value={counterpartyId}
                onChange={setCounterpartyId}
                options={employeeOptions}
                placeholder="Выберите сотрудника"
                searchPlaceholder="Сотрудник…"
                onCreate={(name) => setQuickEmp({ open: true, name })}
                createLabel={(q) => `Добавить сотрудника «${q}»`}
                className="h-9"
              />
            </FormField>
          )}
          <FormField label="Название" required>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={isSalary ? 'Зарплата за июль' : 'Оплата услуги'}
              autoFocus={!isSalary}
            />
          </FormField>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Сумма" required>
              <MoneyInput value={amount} onChange={(e) => setAmount(e.target.value)} />
            </FormField>
            <FormField label="Дата" required>
              <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </FormField>
          </div>
          {!isSalary && (
            <div className="grid grid-cols-2 gap-3">
              <FormField label="Статья">
                <Select value={txKind} onChange={(e) => setTxKind(e.target.value as PlannedTxKind)}>
                  {TX_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {TX_KIND_LABEL[k]}
                    </option>
                  ))}
                </Select>
              </FormField>
              <FormField label="Напомнить за (дней)">
                <Input type="number" min={0} max={60} value={leadDays} onChange={(e) => setLeadDays(e.target.value)} />
              </FormField>
            </div>
          )}
          <FormField label="Счёт списания">
            <Combobox
              value={accountId}
              onChange={setAccountId}
              options={accountOptions}
              placeholder="Выберите при оплате"
              searchPlaceholder="Счёт…"
              className="h-9"
            />
          </FormField>
          {!isSalary && (
            <FormField label="Категория">
              <Combobox
                value={categoryId}
                onChange={setCategoryId}
                options={categoryOptions}
                placeholder="Не выбрана"
                searchPlaceholder="Категория…"
                className="h-9"
              />
            </FormField>
          )}
          <FormField label="Заметка">
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
          </FormField>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Отмена
          </Button>
          <Button onClick={submit} disabled={!valid} loading={pending}>
            {editing ? 'Сохранить' : 'Запланировать'}
          </Button>
        </DialogFooter>
      </DialogContent>
      <QuickCreateCounterpartyDialog
        wsId={wsId}
        role="EMPLOYEE"
        open={quickEmp.open}
        initialName={quickEmp.name}
        onOpenChange={(o) => setQuickEmp((s) => ({ ...s, open: o }))}
        onCreated={(id) => setCounterpartyId(id)}
      />
    </Dialog>
  );
}

function PayDialog({ wsId, plan, onClose }: { wsId: string; plan: PlannedPayment; onClose: () => void }) {
  const accounts = useAccounts(wsId);
  const pay = usePayPlanned(wsId);
  const [accountId, setAccountId] = useState(plan.accountId ?? '');
  const [amount, setAmount] = useState(plan.amount);
  const [date, setDate] = useState(todayISODate());

  const accountOptions = useMemo<ComboboxOption[]>(
    () => (accounts.data ?? []).map((a) => ({ value: a.id, label: a.name })),
    [accounts.data],
  );
  const valid = !!accountId && /^\d+(\.\d{1,2})?$/.test(amount) && Number(amount) > 0 && !!date;

  const submit = () => {
    if (!valid) return;
    pay.mutate(
      { id: plan.id, accountId, amount, date: dateToNoonIso(date) },
      {
        onSuccess: () => {
          toast.success('Платёж оплачен');
          onClose();
        },
        onError: (e) => toast.error(e instanceof Error ? e.message : 'Не удалось оплатить'),
      },
    );
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[420px]">
        <DialogHeader>
          <DialogTitle>Оплата: {plan.title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="rounded-md bg-secondary/40 p-3 text-sm">
            Плановая сумма <b className="tabular-nums">{formatRub(plan.amount, 2)}</b> · срок {formatDate(plan.dueDate)}
          </div>
          <FormField label="Счёт списания" required>
            <Combobox
              value={accountId}
              onChange={setAccountId}
              options={accountOptions}
              placeholder="Выберите счёт"
              searchPlaceholder="Счёт…"
              className="h-9"
            />
          </FormField>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Сумма" required>
              <MoneyInput value={amount} onChange={(e) => setAmount(e.target.value)} />
            </FormField>
            <FormField label="Дата оплаты" required>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </FormField>
          </div>
          <p className="text-xs text-muted-foreground">
            Создастся операция на выбранном счёте и свяжется с планом. Отменить можно в разделе «Оплаченные».
          </p>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Отмена
          </Button>
          <Button onClick={submit} disabled={!valid} loading={pay.isPending}>
            <Check className="h-4 w-4" /> Оплатить
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
