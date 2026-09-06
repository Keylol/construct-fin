'use client';

import { useMemo, useState } from 'react';
import { D, add, toMoneyString } from '@construct/shared';
import { Pencil, Plus, Repeat, Users } from '@/components/ui/icons';
import { Money } from '@/components/ui/Money';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { MoneyInput } from '@/components/ui/MoneyInput';
import { FormField } from '@/components/ui/FormField';
import { EmptyState } from '@/components/ui/EmptyState';
import { KpiCard } from '@/components/ui/KpiCard';
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
import {
  useCounterparties,
  useCreateCounterparty,
  useUpdateCounterparty,
} from '@/hooks/useCounterparties';
import {
  usePlannedList,
  useRecurring,
  useUpcoming,
} from '@/hooks/usePlanning';
import type { Counterparty, PlannedPayment, RecurringPayment } from '@/lib/types';
import { formatDate } from '@/lib/dates';
import { plural } from '@/lib/plural';
import { PayDialog } from '@/components/planning/PayDialog';
import { PlannedDialog } from '@/components/planning/PlannedDialog';
import { RecurringDialog } from '@/components/planning/RecurringDialog';
import {
  PaidActions,
  RecurringActions,
  paidColumns,
  plannedColumns,
  plannedMobileCard,
  recurringColumns,
} from '@/components/planning/planned-columns';
import { scheduleLabel } from '@/components/planning/shared';
import { Checkbox } from '@/components/ui/Checkbox';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { KpiRow } from '@/components/ui/KpiRow';
import { StatusDot } from '@/components/ui/StatusDot';

/**
 * Раздел «Зарплата»: сотрудники (Counterparty role=EMPLOYEE) + зарплатные
 * выплаты (PlannedPayment txKind=SALARY — разовые и из регулярной зарплаты).
 * Выплаты попадают и в общий платёжный календарь «Платежи».
 */
export default function SalaryPage() {
  const { current } = useCurrentWorkspace();
  const wsId = current?.id ?? null;

  const employees = useCounterparties(wsId, undefined, false, 'EMPLOYEE');
  // upcoming материализует регулярку на бэке — без него выплаты из свежего
  // графика появились бы только после захода в «Платежи». Зарплатные — фильтром.
  const upcoming = useUpcoming(wsId, 60);
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

  // Ожидаемые выплаты: зарплатная часть общего горизонта (просроченные + 60 дней).
  const plannedSalary = useMemo(
    () => (upcoming.data?.items ?? []).filter((p) => p.txKind === 'SALARY'),
    [upcoming.data],
  );

  // «Выплачено за месяц» — сумма PAID-выплат с dueDate в текущем месяце.
  const paidThisMonth = useMemo(() => {
    const rows = paid.data ?? [];
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth();
    let sum = D(0);
    for (const p of rows) {
      const d = new Date(p.dueDate);
      if (d.getFullYear() === y && d.getMonth() === m) sum = add(sum, D(p.amount));
    }
    return toMoneyString(sum);
  }, [paid.data]);

  const plannedSum = useMemo(
    () => toMoneyString(plannedSalary.reduce((acc, p) => add(acc, D(p.amount)), D(0))),
    [plannedSalary],
  );

  if (!current) return null;

  const employeeRows = employees.data ?? [];

  const editPlanned = (p: PlannedPayment) =>
    p.source !== 'RECURRING' ? () => setPlannedDialog({ editing: p }) : undefined;
  const plannedCols = plannedColumns({ wsId: current.id, onPay: setPayFor, onEdit: editPlanned });
  const recurringCols = recurringColumns({
    wsId: current.id,
    onEdit: (r) => setRecurringDialog({ editing: r }),
    showKind: false,
  });
  const paidCols = paidColumns(current.id);
  const employeeCols: Column<Counterparty>[] = [
    {
      key: 'name',
      header: 'Сотрудник',
      className: 'w-full max-w-0',
      cell: (emp) => (
        <div className="min-w-0">
          <div className="truncate font-medium">{emp.name}</div>
          <div className="truncate text-xs text-muted-foreground">
            {[emp.position, emp.contact].filter(Boolean).join(' · ') || 'Без должности'}
          </div>
        </div>
      ),
    },
    {
      key: 'recurring',
      header: 'Зарплата',
      cell: (emp) =>
        salaryRecurring.some((r) => r.counterpartyId === emp.id && r.isActive) ? (
          <StatusDot tone="success" label="регулярная" />
        ) : (
          <span className="text-muted-foreground">разовые</span>
        ),
      className: 'w-[130px]',
    },
    {
      key: 'payRate',
      header: 'Оклад',
      align: 'right',
      cell: (emp) =>
        emp.payRate ? <Money value={emp.payRate} tone="plain" className="text-muted-foreground" /> : <span className="text-muted-foreground">—</span>,
      className: 'w-[140px]',
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (emp) => {
        const hasRecurring = salaryRecurring.some((r) => r.counterpartyId === emp.id && r.isActive);
        return (
          <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                setPlannedDialog({ editing: null, presetEmployeeId: emp.id, presetAmount: emp.payRate ?? undefined })
              }
            >
              Выплата
            </Button>
            {!hasRecurring && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  setRecurringDialog({ editing: null, presetEmployeeId: emp.id, presetAmount: emp.payRate ?? undefined })
                }
              >
                <Repeat className="h-3.5 w-3.5" /> Регулярная
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => setEmployeeDialog({ editing: emp })} aria-label="Править">
              <Pencil className="h-4 w-4" />
            </Button>
          </div>
        );
      },
      className: 'w-[300px]',
    },
  ];

  return (
    <>
      <PageHeader
        title="Зарплата"
        description={
          <>
            Сотрудники и выплаты им. Регулярная зарплата создаёт ожидаемые выплаты по
            графику, разовые вносятся вручную. Оплата списывает деньги со счёта и попадает
            в расходы по статье «Зарплата»; выплаты видны и в общем разделе «Платежи».
          </>
        }
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

        {/* KPI */}
        <KpiRow loading={employees.isLoading}>
          <KpiCard label="Сотрудников" value={String(employeeRows.length)} />
          <KpiCard
            label="К выплате"
            value={<Money value={plannedSum} />}
            tone={Number(plannedSum) > 0 ? 'warning' : 'neutral'}
            hint={`${plannedSalary.length} ${plural(plannedSalary.length, 'выплата', 'выплаты', 'выплат')}`}
          />
          <KpiCard label="Выплачено за месяц" value={<Money value={paidThisMonth} />} />
        </KpiRow>

        {/* Сотрудники */}
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-foreground">Сотрудники</h2>
          <div className="rounded-md border border-border bg-card">
            <DataTable
              data={employeeRows}
              columns={employeeCols}
              rowKey={(e) => e.id}
              loading={employees.isLoading}
              error={employees.error}
              onRetry={() => employees.refetch()}
              onRowClick={(emp) => setEmployeeDialog({ editing: emp })}
              empty={
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
              }
              mobileCards={(emp) => (
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium">{emp.name}</span>
                    {emp.payRate && <Money value={emp.payRate} tone="plain" className="text-muted-foreground" />}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {[emp.position, emp.contact].filter(Boolean).join(' · ') || 'Без должности'}
                  </div>
                </div>
              )}
            />
          </div>
        </section>

        {/* Ожидаемые выплаты */}
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-foreground">Ожидаемые выплаты</h2>
          <div className="rounded-md border border-border bg-card">
            <DataTable
              data={plannedSalary}
              columns={plannedCols}
              rowKey={(p) => p.id}
              loading={upcoming.isLoading}
              error={upcoming.error}
              onRetry={() => upcoming.refetch()}
              empty={
                <EmptyState
                  icon={Users}
                  title="Нет ожидаемых выплат"
                  hint="Создайте разовую выплату или настройте регулярную зарплату."
                />
              }
              mobileCards={(p) => plannedMobileCard(p, current.id, () => setPayFor(p), editPlanned(p))}
            />
          </div>
        </section>

        {/* Регулярная зарплата */}
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-foreground">Регулярная зарплата</h2>
          <div className="rounded-md border border-border bg-card">
            <DataTable
              data={salaryRecurring}
              columns={recurringCols}
              rowKey={(r) => r.id}
              loading={recurring.isLoading}
              error={recurring.error}
              onRetry={() => recurring.refetch()}
              empty={
                <EmptyState
                  icon={Repeat}
                  title="Регулярная зарплата не настроена"
                  hint="Задайте график (например, 10-го числа каждого месяца) — выплаты будут появляться сами."
                />
              }
              mobileCards={(r) => (
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium">{r.title}</span>
                    <Money value={r.amount} className="font-semibold" />
                  </div>
                  <div className="text-xs text-muted-foreground">{scheduleLabel(r)}</div>
                  <RecurringActions r={r} wsId={current.id} onEdit={() => setRecurringDialog({ editing: r })} />
                </div>
              )}
            />
          </div>
        </section>

        {/* Выплачено */}
        {(paid.data?.length ?? 0) > 0 && (
          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-muted-foreground">Выплачено</h2>
            <div className="rounded-md border border-border bg-card">
              <DataTable
                data={paid.data ?? []}
                columns={paidCols}
                rowKey={(p) => p.id}
                mobileCards={(p) => (
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate">{p.title}</div>
                      <div className="text-xs text-muted-foreground">{formatDate(p.dueDate)}</div>
                    </div>
                    <PaidActions p={p} wsId={current.id} />
                  </div>
                )}
              />
            </div>
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
    <Modal open onOpenChange={(o) => !o && onClose()} dirty={name !== (editing?.name ?? '') || position !== (editing?.position ?? '') || payRate !== (editing?.payRate ?? '') || contact !== (editing?.contact ?? '') || note !== (editing?.note ?? '') || isArchived !== (editing?.isArchived ?? false)}>
      <ModalContent size="md" onConfirm={submit}>
        <ModalHeader>
          <ModalTitle>{editing ? 'Сотрудник' : 'Новый сотрудник'}</ModalTitle>
        </ModalHeader>
        <ModalBody className="space-y-3">
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
            <Checkbox label="В архиве (уволен)" checked={isArchived} onChange={(e) => setIsArchived(e.target.checked)} />
          )}
        </ModalBody>
        <ModalFooter>
          <ModalClose asChild>
            <Button variant="secondary">Отмена</Button>
          </ModalClose>
          <Button onClick={submit} disabled={!valid} loading={pending}>
            {editing ? 'Сохранить' : 'Добавить'}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
