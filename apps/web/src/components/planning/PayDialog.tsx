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
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
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
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[420px]">
        <DialogHeader>
          <DialogTitle>Оплата: {plan.title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
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
