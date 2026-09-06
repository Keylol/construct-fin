'use client';

import { useMemo, useState } from 'react';
import { Check } from '@/components/ui/icons';
import { Money } from '@/components/ui/Money';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
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
import { useAccounts } from '@/hooks/useAccounts';
import { usePayPlanned } from '@/hooks/usePlanning';
import type { PlannedPayment } from '@/lib/types';
import { formatDate } from '@/lib/dates';
import { dateToNoonIso, todayISODate } from './shared';

/** Оплата планового платежа: создаёт операцию на счёте и связывает с планом. */
export function PayDialog({
  wsId,
  plan,
  onClose,
}: {
  wsId: string;
  plan: PlannedPayment;
  onClose: () => void;
}) {
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
    <Modal open onOpenChange={(o) => !o && onClose()} dirty={amount !== plan.amount || accountId !== (plan.accountId ?? '')}>
      <ModalContent size="md" onConfirm={submit}>
        <ModalHeader>
          <ModalTitle>Оплата: {plan.title}</ModalTitle>
        </ModalHeader>
        <ModalBody className="space-y-3">
          <div className="rounded-md bg-secondary/40 p-3 text-sm">
            Плановая сумма <b className="tabular-nums"><Money value={plan.amount} /></b> · срок{' '}
            {formatDate(plan.dueDate)}
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
            Создастся операция на выбранном счёте и свяжется с планом. Отменить можно в разделе
            «Оплаченные».
          </p>
        </ModalBody>
        <ModalFooter>
          <ModalClose asChild>
            <Button variant="secondary">Отмена</Button>
          </ModalClose>
          <Button onClick={submit} disabled={!valid} loading={pay.isPending}>
            <Check className="h-4 w-4" /> Оплатить
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
