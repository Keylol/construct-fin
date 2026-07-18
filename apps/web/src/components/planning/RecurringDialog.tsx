'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { MoneyInput } from '@/components/ui/MoneyInput';
import { FormField } from '@/components/ui/FormField';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { toast } from '@/components/ui/Toaster';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { QuickCreateCounterpartyDialog } from '@/components/counterparties/QuickCreateCounterpartyDialog';
import { useAccounts } from '@/hooks/useAccounts';
import { useCategories } from '@/hooks/useCategories';
import { useCounterparties } from '@/hooks/useCounterparties';
import { useCreateRecurring, useUpdateRecurring } from '@/hooks/usePlanning';
import type { PlannedTxKind, RecurrenceCadence, RecurringPayment } from '@/lib/types';
import { TX_KIND_LABEL, TX_KINDS, WEEKDAYS, dateToNoonIso, todayISODate } from './shared';

interface RecurringDialogProps {
  wsId: string;
  editing: RecurringPayment | null;
  onClose: () => void;
  /**
   * salary — регулярная зарплата: статья фиксирована (SALARY), обязателен
   * сотрудник (Counterparty role=EMPLOYEE), категория скрыта. general — как было.
   */
  mode?: 'general' | 'salary';
  /** Предзаполнение из карточки сотрудника (id + оклад). */
  presetEmployeeId?: string;
  presetAmount?: string;
}

/** Шаблон регулярного платежа (MONTHLY/WEEKLY); позиции материализуются сами. */
export function RecurringDialog({
  wsId,
  editing,
  onClose,
  mode = 'general',
  presetEmployeeId,
  presetAmount,
}: RecurringDialogProps) {
  const isSalary = mode === 'salary';
  const accounts = useAccounts(wsId);
  const categories = useCategories(wsId, 'EXPENSE');
  const employees = useCounterparties(wsId, undefined, false, 'EMPLOYEE');
  const create = useCreateRecurring(wsId);
  const update = useUpdateRecurring(wsId);

  const [title, setTitle] = useState(editing?.title ?? '');
  const [amount, setAmount] = useState(editing?.amount ?? presetAmount ?? '');
  const [txKind, setTxKind] = useState<PlannedTxKind>(
    editing?.txKind ?? (isSalary ? 'SALARY' : 'FIXED_COST'),
  );
  const [cadence, setCadence] = useState<RecurrenceCadence>(editing?.cadence ?? 'MONTHLY');
  const [dayOfMonth, setDayOfMonth] = useState(String(editing?.dayOfMonth ?? 1));
  const [weekday, setWeekday] = useState(String(editing?.weekday ?? 1));
  const [startDate, setStartDate] = useState(editing?.startDate.slice(0, 10) ?? todayISODate());
  const [leadDays, setLeadDays] = useState(String(editing?.leadDays ?? 3));
  const [accountId, setAccountId] = useState(editing?.accountId ?? '');
  const [categoryId, setCategoryId] = useState(editing?.categoryId ?? '');
  const [counterpartyId, setCounterpartyId] = useState(
    editing?.counterpartyId ?? presetEmployeeId ?? '',
  );
  const [note, setNote] = useState(editing?.note ?? '');
  const [quickEmp, setQuickEmp] = useState<{ open: boolean; name: string }>({
    open: false,
    name: '',
  });

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

  /** Выбор сотрудника автоподставляет название и оклад (если поля ещё пустые). */
  const pickEmployee = (id: string) => {
    setCounterpartyId(id);
    const emp = (employees.data ?? []).find((e) => e.id === id);
    if (emp) {
      if (!title.trim()) setTitle(`Зарплата — ${emp.name}`);
      if (!amount.trim() && emp.payRate) setAmount(emp.payRate);
    }
  };

  // Открытие из карточки сотрудника (preset): имя подставляется, как только
  // подгрузился список сотрудников; пользовательский ввод не перетираем.
  useEffect(() => {
    if (editing || !presetEmployeeId || title.trim()) return;
    const emp = (employees.data ?? []).find((e) => e.id === presetEmployeeId);
    if (emp) setTitle(`Зарплата — ${emp.name}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employees.data]);

  const valid =
    title.trim() !== '' &&
    /^\d+(\.\d{1,2})?$/.test(amount) &&
    Number(amount) > 0 &&
    (!isSalary || !!counterpartyId);
  const pending = create.isPending || update.isPending;

  const submit = () => {
    if (!valid) return;
    const payload = {
      title: title.trim(),
      amount,
      txKind: isSalary ? ('SALARY' as const) : txKind,
      cadence,
      dayOfMonth: cadence === 'MONTHLY' ? Number(dayOfMonth) : null,
      weekday: cadence === 'WEEKLY' ? Number(weekday) : null,
      startDate: dateToNoonIso(startDate),
      leadDays: Number(leadDays),
      accountId: accountId || null,
      categoryId: isSalary ? null : categoryId || null,
      counterpartyId: counterpartyId || null,
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

  const heading = isSalary
    ? editing
      ? 'Регулярная зарплата'
      : 'Новая регулярная зарплата'
    : editing
      ? 'Регулярный платёж'
      : 'Новый регулярный платёж';

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[460px]">
        <DialogHeader>
          <DialogTitle>{heading}</DialogTitle>
        </DialogHeader>
        <div className="max-h-[70vh] space-y-3 overflow-y-auto py-2">
          {isSalary && (
            <FormField label="Сотрудник" required>
              <Combobox
                value={counterpartyId}
                onChange={pickEmployee}
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
              placeholder={isSalary ? 'Зарплата — Иванов' : 'Аренда офиса'}
              autoFocus={!isSalary}
            />
          </FormField>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Сумма" required>
              <MoneyInput value={amount} onChange={(e) => setAmount(e.target.value)} />
            </FormField>
            {isSalary ? (
              <FormField label="Статья">
                <Input value={TX_KIND_LABEL.SALARY} disabled />
              </FormField>
            ) : (
              <FormField label="Статья">
                <Select value={txKind} onChange={(e) => setTxKind(e.target.value as PlannedTxKind)}>
                  {TX_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {TX_KIND_LABEL[k]}
                    </option>
                  ))}
                </Select>
              </FormField>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Периодичность">
              <Select
                value={cadence}
                onChange={(e) => setCadence(e.target.value as RecurrenceCadence)}
              >
                <option value="MONTHLY">Ежемесячно</option>
                <option value="WEEKLY">Еженедельно</option>
              </Select>
            </FormField>
            {cadence === 'MONTHLY' ? (
              <FormField label="Число месяца" hint="1–31, лишнее подтянется к концу месяца">
                <Input
                  type="number"
                  min={1}
                  max={31}
                  value={dayOfMonth}
                  onChange={(e) => setDayOfMonth(e.target.value)}
                />
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
              <Input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </FormField>
            <FormField label="Напомнить за (дней)">
              <Input
                type="number"
                min={0}
                max={60}
                value={leadDays}
                onChange={(e) => setLeadDays(e.target.value)}
              />
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
            {editing ? 'Сохранить' : 'Создать'}
          </Button>
        </DialogFooter>
      </DialogContent>
      <QuickCreateCounterpartyDialog
        wsId={wsId}
        role="EMPLOYEE"
        open={quickEmp.open}
        initialName={quickEmp.name}
        onOpenChange={(o) => setQuickEmp((s) => ({ ...s, open: o }))}
        onCreated={(id) => pickEmployee(id)}
      />
    </Dialog>
  );
}
