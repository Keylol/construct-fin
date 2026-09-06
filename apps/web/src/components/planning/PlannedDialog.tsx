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
  Modal,
  ModalBody,
  ModalClose,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/Modal';
import { QuickCreateCounterpartyDialog } from '@/components/counterparties/QuickCreateCounterpartyDialog';
import { useAccounts } from '@/hooks/useAccounts';
import { useCategories } from '@/hooks/useCategories';
import { useCounterparties } from '@/hooks/useCounterparties';
import { useCreatePlanned, useUpdatePlanned } from '@/hooks/usePlanning';
import type { PlannedPayment, PlannedTxKind } from '@/lib/types';
import { TX_KIND_LABEL, TX_KINDS, dateToNoonIso, todayISODate } from './shared';

interface PlannedDialogProps {
  wsId: string;
  mode: 'manual' | 'salary';
  editing: PlannedPayment | null;
  onClose: () => void;
  /** Предзаполнение зарплатной выплаты из карточки сотрудника (id + оклад). */
  presetEmployeeId?: string;
  presetAmount?: string;
}

/** Разовый плановый платёж / выплата зарплаты (mode='salary' требует сотрудника). */
export function PlannedDialog({
  wsId,
  mode,
  editing,
  onClose,
  presetEmployeeId,
  presetAmount,
}: PlannedDialogProps) {
  const isSalary = mode === 'salary';
  const accounts = useAccounts(wsId);
  const categories = useCategories(wsId, 'EXPENSE');
  const employees = useCounterparties(wsId, undefined, false, 'EMPLOYEE');
  const create = useCreatePlanned(wsId);
  const update = useUpdatePlanned(wsId);

  const [title, setTitle] = useState(editing?.title ?? '');
  const [amount, setAmount] = useState(editing?.amount ?? presetAmount ?? '');
  const [txKind, setTxKind] = useState<PlannedTxKind>(
    editing?.txKind ?? (isSalary ? 'SALARY' : 'FIXED_COST'),
  );
  const [dueDate, setDueDate] = useState(editing?.dueDate.slice(0, 10) ?? todayISODate());
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
    <Modal open onOpenChange={(o) => !o && onClose()} dirty={title !== (editing?.title ?? '') || amount !== (editing?.amount ?? presetAmount ?? '') || note !== (editing?.note ?? '')}>
      <ModalContent size="md" onConfirm={submit}>
        <ModalHeader>
          <ModalTitle>{heading}</ModalTitle>
        </ModalHeader>
        <ModalBody className="space-y-3">
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
                <Input
                  type="number"
                  min={0}
                  max={60}
                  value={leadDays}
                  onChange={(e) => setLeadDays(e.target.value)}
                />
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
        </ModalBody>
        <ModalFooter>
          <ModalClose asChild>
            <Button variant="secondary">Отмена</Button>
          </ModalClose>
          <Button onClick={submit} disabled={!valid} loading={pending}>
            {editing ? 'Сохранить' : 'Запланировать'}
          </Button>
        </ModalFooter>
      </ModalContent>
      <QuickCreateCounterpartyDialog
        wsId={wsId}
        role="EMPLOYEE"
        open={quickEmp.open}
        initialName={quickEmp.name}
        onOpenChange={(o) => setQuickEmp((s) => ({ ...s, open: o }))}
        onCreated={(id) => setCounterpartyId(id)}
      />
    </Modal>
  );
}
