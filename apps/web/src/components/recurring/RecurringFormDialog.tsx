'use client';

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { parseAmountInput } from '@construct/shared';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { FormField } from '@/components/ui/FormField';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/Sheet';
import { useAccounts } from '@/hooks/useAccounts';
import { useCategories } from '@/hooks/useCategories';
import { useCounterparties } from '@/hooks/useCounterparties';
import type { CreateRecurringInput, UpdateRecurringInput } from '@/hooks/useRecurring';
import type { RecurringFrequency, RecurringRule, TxType } from '@/lib/types';
import { cn } from '@/lib/cn';

const FREQ_LABEL: Record<RecurringFrequency, string> = {
  DAILY: 'Каждый день',
  WEEKLY: 'Каждую неделю',
  MONTHLY: 'Каждый месяц',
  YEARLY: 'Каждый год',
};

const WEEKDAY_LABEL = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

interface Props {
  wsId: string;
  open: boolean;
  rule?: RecurringRule | null;
  onClose: () => void;
  onSubmit: (input: CreateRecurringInput | UpdateRecurringInput) => Promise<void>;
}

export function RecurringFormDialog({ wsId, open, rule, onClose, onSubmit }: Props) {
  const accounts = useAccounts(wsId);
  const categories = useCategories(wsId);
  const counterparties = useCounterparties(wsId);

  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [type, setType] = useState<TxType>('EXPENSE');
  const [accountId, setAccountId] = useState('');
  const [categoryId, setCategoryId] = useState<string>('');
  const [counterpartyId, setCounterpartyId] = useState<string>('');
  const [description, setDescription] = useState('');
  const [frequency, setFrequency] = useState<RecurringFrequency>('MONTHLY');
  const [interval, setInterval] = useState(1);
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10));
  const [endDate, setEndDate] = useState('');
  const [dayOfMonth, setDayOfMonth] = useState<number>(1);
  const [dayOfWeek, setDayOfWeek] = useState<number>(0);
  const [active, setActive] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    if (rule) {
      setName(rule.name);
      setAmount(rule.templateJson.amount);
      setType(rule.templateJson.type);
      setAccountId(rule.templateJson.accountId);
      setCategoryId(rule.templateJson.categoryId ?? '');
      setCounterpartyId(rule.templateJson.counterpartyId ?? '');
      setDescription(rule.templateJson.description ?? '');
      setFrequency(rule.frequency);
      setInterval(rule.interval);
      setStartDate(rule.startDate.slice(0, 10));
      setEndDate(rule.endDate?.slice(0, 10) ?? '');
      setDayOfMonth(rule.dayOfMonth ?? 1);
      setDayOfWeek(rule.dayOfWeek ?? 0);
      setActive(rule.active);
    } else {
      setName('');
      setAmount('');
      setType('EXPENSE');
      setAccountId('');
      setCategoryId('');
      setCounterpartyId('');
      setDescription('');
      setFrequency('MONTHLY');
      setInterval(1);
      setStartDate(new Date().toISOString().slice(0, 10));
      setEndDate('');
      setDayOfMonth(1);
      setDayOfWeek(0);
      setActive(true);
    }
    setError(null);
  }, [open, rule]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const parsedAmount = parseAmountInput(amount);
    if (!parsedAmount) {
      setError('Сумма указана неверно');
      return;
    }
    if (!accountId) {
      setError('Выберите счёт');
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit({
        name: name.trim(),
        template: {
          amount: parsedAmount,
          type,
          accountId,
          categoryId: categoryId || null,
          counterpartyId: counterpartyId || null,
          description: description.trim() || null,
        },
        frequency,
        interval,
        startDate: new Date(startDate).toISOString(),
        endDate: endDate ? new Date(endDate).toISOString() : null,
        dayOfMonth: frequency === 'MONTHLY' || frequency === 'YEARLY' ? dayOfMonth : null,
        dayOfWeek: frequency === 'WEEKLY' ? dayOfWeek : null,
        active,
      });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  const accountOptions = (accounts.data ?? []).filter((a) => !a.isArchived);
  const filteredCategories = (categories.data ?? []).filter(
    (c) => c.kind === type && !c.isArchived,
  );

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" hideClose className="sm:max-w-lg">
        <SheetHeader className="flex-row items-center justify-between gap-2 space-y-0">
          <SheetTitle>{rule ? 'Редактировать правило' : 'Новое правило'}</SheetTitle>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Закрыть">
            <X className="h-4 w-4" />
          </Button>
        </SheetHeader>
        <form id="recurring-form" onSubmit={handleSubmit}>
          <SheetBody className="space-y-4">
            <FormField label="Название" required>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Зарплата / Аренда / …"
                required
              />
            </FormField>

            <div className="grid grid-cols-2 gap-3">
              <FormField label="Сумма (₽)" required>
                <Input
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0,00"
                  inputMode="decimal"
                  required
                />
              </FormField>
              <FormField label="Тип">
                <Select value={type} onChange={(e) => setType(e.target.value as TxType)}>
                  <option value="EXPENSE">Расход</option>
                  <option value="INCOME">Доход</option>
                </Select>
              </FormField>
            </div>

            <FormField label="Счёт" required>
              <Select
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                required
              >
                <option value="">— выберите —</option>
                {accountOptions.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.type})
                  </option>
                ))}
              </Select>
            </FormField>

            <div className="grid grid-cols-2 gap-3">
              <FormField label="Категория">
                <Select
                  value={categoryId}
                  onChange={(e) => setCategoryId(e.target.value)}
                >
                  <option value="">— без категории —</option>
                  {filteredCategories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </FormField>
              <FormField label="Контрагент">
                <Select
                  value={counterpartyId}
                  onChange={(e) => setCounterpartyId(e.target.value)}
                >
                  <option value="">— нет —</option>
                  {(counterparties.data ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </FormField>
            </div>

            <FormField label="Описание">
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Опционально"
              />
            </FormField>

            <div className="space-y-1.5 border-t border-border pt-4">
              <span className="block text-sm font-medium text-foreground">Частота</span>
              <div className="grid grid-cols-2 gap-2">
                {(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] as RecurringFrequency[]).map(
                  (f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setFrequency(f)}
                      className={cn(
                        'flex h-9 items-center justify-center rounded-md border text-sm transition-colors',
                        frequency === f
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-input bg-background hover:bg-secondary',
                      )}
                    >
                      {FREQ_LABEL[f]}
                    </button>
                  ),
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <FormField label="Каждые N">
                <Input
                  type="number"
                  min={1}
                  max={365}
                  value={interval}
                  onChange={(e) => setInterval(Number(e.target.value) || 1)}
                />
              </FormField>
              {frequency === 'WEEKLY' && (
                <FormField label="День недели">
                  <Select
                    value={dayOfWeek}
                    onChange={(e) => setDayOfWeek(Number(e.target.value))}
                  >
                    {WEEKDAY_LABEL.map((d, i) => (
                      <option key={i} value={i}>
                        {d}
                      </option>
                    ))}
                  </Select>
                </FormField>
              )}
              {(frequency === 'MONTHLY' || frequency === 'YEARLY') && (
                <FormField label="День месяца">
                  <Input
                    type="number"
                    min={1}
                    max={31}
                    value={dayOfMonth}
                    onChange={(e) => setDayOfMonth(Number(e.target.value) || 1)}
                  />
                </FormField>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <FormField label="Старт" required>
                <Input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  required
                />
              </FormField>
              <FormField label="Окончание (опц.)">
                <Input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                />
              </FormField>
            </div>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={active}
                onChange={(e) => setActive(e.target.checked)}
                className="h-4 w-4 rounded border-input accent-primary"
              />
              Правило активно
            </label>

            {error && <p className="text-sm text-destructive">{error}</p>}
          </SheetBody>
          <SheetFooter>
            <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>
              Отмена
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Сохраняю…' : rule ? 'Сохранить' : 'Создать'}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
