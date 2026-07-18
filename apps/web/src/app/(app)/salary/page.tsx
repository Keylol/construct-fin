'use client';

import { useMemo, useState } from 'react';
import { formatRub } from '@construct/shared';
import { Pencil, Plus, Repeat, Users } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { MoneyInput } from '@/components/ui/MoneyInput';
import { FormField } from '@/components/ui/FormField';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { KpiCard } from '@/components/ui/KpiCard';
import { Badge } from '@/components/ui/Badge';
import { toast } from '@/components/ui/Toaster';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import {
  useCounterparties,
  useCreateCounterparty,
  useUpdateCounterparty,
} from '@/hooks/useCounterparties';
import { usePlannedList, useRecurring, useUpdateRecurring } from '@/hooks/usePlanning';
import type { Counterparty, PlannedPayment, RecurringPayment } from '@/lib/types';
import { formatDate } from '@/lib/dates';
import { PayDialog } from '@/components/planning/PayDialog';
import { PlannedDialog } from '@/components/planning/PlannedDialog';
import { RecurringDialog } from '@/components/planning/RecurringDialog';
import { PaidRow, PlannedRow } from '@/components/planning/PlannedRows';
import { scheduleLabel } from '@/components/planning/shared';

/**
 * Раздел «Зарплата»: сотрудники (Counterparty role=EMPLOYEE) + зарплатные
 * выплаты (PlannedPayment txKind=SALARY — разовые и из регулярной зарплаты).
 * Выплаты попадают и в общий платёжный календарь «Платежи».
 */
export default function SalaryPage() {
  const { current } = useCurrentWorkspace();
  const wsId = current?.id ?? null;

  const employees = useCounterparties(wsId, undefined, false, 'EMPLOYEE');
  const planned = usePlannedList(wsId, { status: 'PLANNED', txKind: 'SALARY' });
  const paid = usePlannedList(wsId, { status: 'PAID', txKind: 'SALARY' });
  const recurring = useRecurring(wsId);

  const [employeeDialog, setEmployeeDialog] = useState<{ editing: Counterparty | null } | null>(
    null,
  );
  const [plannedDialog, setPlannedDialog] = useState<{
    editing: PlannedPayment | null;
    presetEmployeeId?: string;
    presetAmount?: string;
  } | null>(null);
  const [recurringDialog, setRecurringDialog] = useState<{
    editing: RecurringPayment | null;
    presetEmployeeId?: string;
    presetAmount?: string;
  } | null>(null);
  const [payFor, setPayFor] = useState<PlannedPayment | null>(null);

  // Регулярная зарплата — правила со статьёй SALARY (фильтр на клиенте: правил мало).
  const salaryRecurring = useMemo(
    () => (recurring.data ?? []).filter((r) => r.txKind === 'SALARY'),
    [recurring.data],
  );

  // «Выплачено за месяц» — сумма PAID-выплат с dueDate в текущем месяце.
  const paidThisMonth = useMemo(() => {
    const rows = paid.data ?? [];
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth();
    let sum = 0;
    for (const p of rows) {
      const d = new Date(p.dueDate);
      if (d.getFullYear() === y && d.getMonth() === m) sum += Number(p.amount);
    }
    return sum.toFixed(2);
  }, [paid.data]);

  const plannedSum = useMemo(
    () => (planned.data ?? []).reduce((acc, p) => acc + Number(p.amount), 0).toFixed(2),
    [planned.data],
  );

  if (!current) {
    return (
      <>
        <PageHeader title="Зарплата" />
        <div className="p-6">
          <EmptyState
            icon={Users}
            title="Нет активного пространства"
            hint="Выберите пространство."
          />
        </div>
      </>
    );
  }

  const employeeRows = employees.data ?? [];

  return (
    <>
      <PageHeader
        title="Зарплата"
        breadcrumbs={[{ label: 'Зарплата' }]}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setEmployeeDialog({ editing: null })}
            >
              <Plus className="h-4 w-4" /> Сотрудник
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setRecurringDialog({ editing: null })}
            >
              <Repeat className="h-4 w-4" /> Регулярная зарплата
            </Button>
            <Button size="sm" onClick={() => setPlannedDialog({ editing: null })}>
              <Plus className="h-4 w-4" /> Выплата
            </Button>
          </div>
        }
      />

      <div className="space-y-6 px-6 py-4">
        <p className="max-w-3xl text-sm text-muted-foreground">
          Сотрудники и выплаты им. Регулярная зарплата создаёт ожидаемые выплаты по
          графику, разовые вносятся вручную. Оплата списывает деньги со счёта и попадает
          в расходы по статье «Зарплата»; выплаты видны и в общем разделе «Платежи».
        </p>

        {/* KPI */}
        <div className="grid gap-4 sm:grid-cols-3">
          <KpiCard label="Сотрудников" value={String(employeeRows.length)} />
          <KpiCard
            label="К выплате"
            value={formatRub(plannedSum)}
            tone={Number(plannedSum) > 0 ? 'warning' : 'neutral'}
            hint={`${planned.data?.length ?? 0} выплат(ы)`}
          />
          <KpiCard label="Выплачено за месяц" value={formatRub(paidThisMonth)} />
        </div>

        {/* Сотрудники */}
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-foreground">Сотрудники</h2>
          {employees.isLoading ? (
            <Skeleton className="h-24" />
          ) : employeeRows.length === 0 ? (
            <EmptyState
              icon={Users}
              title="Пока нет сотрудников"
              hint="Добавьте сотрудника — имя, должность, оклад. Дальше — регулярная зарплата или разовая выплата."
              action={
                <Button onClick={() => setEmployeeDialog({ editing: null })}>
                  <Plus className="h-4 w-4" /> Добавить сотрудника
                </Button>
              }
            />
          ) : (
            <Card className="divide-y divide-border/60 p-0">
              {employeeRows.map((emp) => (
                <EmployeeRow
                  key={emp.id}
                  emp={emp}
                  hasRecurring={salaryRecurring.some(
                    (r) => r.counterpartyId === emp.id && r.isActive,
                  )}
                  onEdit={() => setEmployeeDialog({ editing: emp })}
                  onPayOnce={() =>
                    setPlannedDialog({
                      editing: null,
                      presetEmployeeId: emp.id,
                      presetAmount: emp.payRate ?? undefined,
                    })
                  }
                  onRecurring={() =>
                    setRecurringDialog({
                      editing: null,
                      presetEmployeeId: emp.id,
                      presetAmount: emp.payRate ?? undefined,
                    })
                  }
                />
              ))}
            </Card>
          )}
        </section>

        {/* Ожидаемые выплаты */}
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-foreground">Ожидаемые выплаты</h2>
          {planned.isLoading ? (
            <Skeleton className="h-24" />
          ) : (planned.data?.length ?? 0) === 0 ? (
            <EmptyState
              icon={Users}
              title="Нет ожидаемых выплат"
              hint="Создайте разовую выплату или настройте регулярную зарплату."
            />
          ) : (
            <Card className="divide-y divide-border/60 p-0">
              {planned.data!.map((p) => (
                <PlannedRow
                  key={p.id}
                  p={p}
                  onPay={() => setPayFor(p)}
                  onEdit={
                    p.source !== 'RECURRING'
                      ? () => setPlannedDialog({ editing: p })
                      : undefined
                  }
                  wsId={current.id}
                />
              ))}
            </Card>
          )}
        </section>

        {/* Регулярная зарплата */}
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-foreground">Регулярная зарплата</h2>
          {recurring.isLoading ? (
            <Skeleton className="h-16" />
          ) : salaryRecurring.length === 0 ? (
            <EmptyState
              icon={Repeat}
              title="Регулярная зарплата не настроена"
              hint="Задайте график (например, 10-го числа каждого месяца) — выплаты будут появляться сами."
            />
          ) : (
            <Card className="divide-y divide-border/60 p-0">
              {salaryRecurring.map((r) => (
                <SalaryRecurringRow
                  key={r.id}
                  r={r}
                  wsId={current.id}
                  onEdit={() => setRecurringDialog({ editing: r })}
                />
              ))}
            </Card>
          )}
        </section>

        {/* Выплачено */}
        {(paid.data?.length ?? 0) > 0 && (
          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-muted-foreground">Выплачено</h2>
            <Card className="divide-y divide-border/60 p-0">
              {paid.data!.map((p) => (
                <PaidRow key={p.id} p={p} wsId={current.id} />
              ))}
            </Card>
          </section>
        )}
      </div>

      {employeeDialog && (
        <EmployeeDialog
          wsId={current.id}
          editing={employeeDialog.editing}
          onClose={() => setEmployeeDialog(null)}
        />
      )}
      {plannedDialog && (
        <PlannedDialog
          wsId={current.id}
          mode="salary"
          editing={plannedDialog.editing}
          presetEmployeeId={plannedDialog.presetEmployeeId}
          presetAmount={plannedDialog.presetAmount}
          onClose={() => setPlannedDialog(null)}
        />
      )}
      {recurringDialog && (
        <RecurringDialog
          wsId={current.id}
          mode="salary"
          editing={recurringDialog.editing}
          presetEmployeeId={recurringDialog.presetEmployeeId}
          presetAmount={recurringDialog.presetAmount}
          onClose={() => setRecurringDialog(null)}
        />
      )}
      {payFor && <PayDialog wsId={current.id} plan={payFor} onClose={() => setPayFor(null)} />}
    </>
  );
}

function EmployeeRow({
  emp,
  hasRecurring,
  onEdit,
  onPayOnce,
  onRecurring,
}: {
  emp: Counterparty;
  hasRecurring: boolean;
  onEdit: () => void;
  onPayOnce: () => void;
  onRecurring: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{emp.name}</span>
          {hasRecurring && <Badge variant="outline">регулярная</Badge>}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {[emp.position, emp.contact].filter(Boolean).join(' · ') || 'Без должности'}
        </div>
      </div>
      {emp.payRate && (
        <div className="text-right text-sm tabular-nums text-muted-foreground">
          оклад {formatRub(emp.payRate)}
        </div>
      )}
      <div className="flex shrink-0 items-center gap-1">
        <Button variant="secondary" size="sm" onClick={onPayOnce}>
          Выплата
        </Button>
        {!hasRecurring && (
          <Button variant="ghost" size="sm" onClick={onRecurring}>
            <Repeat className="h-3.5 w-3.5" /> Регулярная
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={onEdit} aria-label="Править">
          <Pencil className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function SalaryRecurringRow({
  r,
  wsId,
  onEdit,
}: {
  r: RecurringPayment;
  wsId: string;
  onEdit: () => void;
}) {
  const update = useUpdateRecurring(wsId);
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
            <span className="rounded-full bg-secondary px-2 py-0.5 text-[11px] text-muted-foreground">
              пауза
            </span>
          )}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {scheduleLabel(r)}
          {r.counterpartyName && ` · ${r.counterpartyName}`}
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
      </div>
    </div>
  );
}

/** Карточка сотрудника: имя, должность, оклад, контакт, заметка, архив. */
function EmployeeDialog({
  wsId,
  editing,
  onClose,
}: {
  wsId: string;
  editing: Counterparty | null;
  onClose: () => void;
}) {
  const create = useCreateCounterparty(wsId);
  const update = useUpdateCounterparty(wsId);

  const [name, setName] = useState(editing?.name ?? '');
  const [position, setPosition] = useState(editing?.position ?? '');
  const [payRate, setPayRate] = useState(editing?.payRate ?? '');
  const [contact, setContact] = useState(editing?.contact ?? '');
  const [note, setNote] = useState(editing?.note ?? '');
  const [isArchived, setIsArchived] = useState(editing?.isArchived ?? false);

  const payRateValid = payRate.trim() === '' || /^\d+(\.\d{1,2})?$/.test(payRate);
  const valid = name.trim() !== '' && payRateValid;
  const pending = create.isPending || update.isPending;

  const submit = () => {
    if (!valid) return;
    const done = {
      onSuccess: () => {
        toast.success(editing ? 'Сотрудник обновлён' : 'Сотрудник добавлен');
        onClose();
      },
      onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Не удалось сохранить'),
    };
    if (editing) {
      update.mutate(
        {
          id: editing.id,
          name: name.trim(),
          position: position.trim() || null,
          payRate: payRate.trim() || null,
          contact: contact.trim() || null,
          note: note.trim() || null,
          isArchived,
        },
        done,
      );
    } else {
      create.mutate(
        {
          name: name.trim(),
          role: 'EMPLOYEE',
          position: position.trim() || undefined,
          payRate: payRate.trim() || undefined,
          contact: contact.trim() || undefined,
          note: note.trim() || undefined,
        },
        done,
      );
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[420px]">
        <DialogHeader>
          <DialogTitle>{editing ? 'Сотрудник' : 'Новый сотрудник'}</DialogTitle>
        </DialogHeader>
        <div className="max-h-[70vh] space-y-3 overflow-y-auto py-2">
          <FormField label="Имя" required>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Иванов Иван"
              autoFocus
            />
          </FormField>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Должность">
              <Input
                value={position}
                onChange={(e) => setPosition(e.target.value)}
                placeholder="Сборщик"
              />
            </FormField>
            <FormField label="Оклад (₽/мес)" hint="Подставляется в выплаты">
              <MoneyInput value={payRate} onChange={(e) => setPayRate(e.target.value)} />
            </FormField>
          </div>
          <FormField label="Контакт">
            <Input
              value={contact}
              onChange={(e) => setContact(e.target.value)}
              placeholder="телефон, @username"
            />
          </FormField>
          <FormField label="Заметка">
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
          </FormField>
          {editing && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={isArchived}
                onChange={(e) => setIsArchived(e.target.checked)}
                className="h-4 w-4 rounded border-input accent-primary"
              />
              В архиве (уволен)
            </label>
          )}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Отмена
          </Button>
          <Button onClick={submit} disabled={!valid} loading={pending}>
            {editing ? 'Сохранить' : 'Добавить'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
