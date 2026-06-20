'use client';

import { useEffect, useState } from 'react';
import { Paperclip, Trash2, X } from '@/components/ui/icons';
import type { TxType, Account, Category, Counterparty } from '@/lib/types';
import {
  useCreateTransaction,
  useDeleteTransaction,
  useUpdateTransaction,
  useTransaction,
  useUploadAttachment,
  useDeleteAttachment,
} from '@/hooks/useTransactions';
import { useAccounts } from '@/hooks/useAccounts';
import { useCategories } from '@/hooks/useCategories';
import { useCounterparties } from '@/hooks/useCounterparties';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/Sheet';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { FormField } from '@/components/ui/FormField';
import { Badge } from '@/components/ui/Badge';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { cn } from '@/lib/cn';
import { toLocalDateInput, fromLocalDateInput } from '@/lib/periods';
import { parseAmountInput } from '@construct/shared';

interface Props {
  wsId: string;
  open: boolean;
  transactionId: string | null; // null = create
  onClose: () => void;
}

export function TransactionFormDialog({ wsId, open, transactionId, onClose }: Props) {
  const isEdit = !!transactionId;
  const existing = useTransaction(wsId, transactionId);
  const accounts = useAccounts(wsId);
  const incomeCats = useCategories(wsId, 'INCOME');
  const expenseCats = useCategories(wsId, 'EXPENSE');
  const counterparties = useCounterparties(wsId);
  const create = useCreateTransaction(wsId);
  const update = useUpdateTransaction(wsId);
  const del = useDeleteTransaction(wsId);
  const upload = useUploadAttachment(wsId);
  const removeAtt = useDeleteAttachment(wsId);

  const [type, setType] = useState<TxType>('EXPENSE');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(toLocalDateInput(new Date()));
  const [accountId, setAccountId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [counterpartyId, setCounterpartyId] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (existing.data) {
      setType(existing.data.type);
      setAmount(existing.data.amount);
      setDate(toLocalDateInput(existing.data.date));
      setAccountId(existing.data.accountId);
      setCategoryId(existing.data.categoryId ?? '');
      setCounterpartyId(existing.data.counterpartyId ?? '');
      setDescription(existing.data.description ?? '');
    } else if (!isEdit) {
      setType('EXPENSE');
      setAmount('');
      setDate(toLocalDateInput(new Date()));
      setAccountId(accounts.data?.[0]?.id ?? '');
      setCategoryId('');
      setCounterpartyId('');
      setDescription('');
    }
    setError(null);
  }, [open, existing.data, isEdit, accounts.data]);

  const cats = type === 'INCOME' ? incomeCats.data ?? [] : expenseCats.data ?? [];
  const rootCats = cats.filter((c) => c.parentId === null && !c.isArchived);
  const childCats = (parentId: string) =>
    cats.filter((c) => c.parentId === parentId && !c.isArchived);
  const selectedCat = cats.find((c) => c.id === categoryId);

  const onSave = async () => {
    setError(null);
    const normalized = parseAmountInput(amount);
    if (!normalized) {
      setError('Сумма указана некорректно');
      return;
    }
    if (!accountId) {
      setError('Выберите счёт');
      return;
    }
    const payload = {
      date: fromLocalDateInput(date),
      amount: normalized,
      type,
      accountId,
      categoryId: categoryId || null,
      counterpartyId: counterpartyId || null,
      description: description.trim() || undefined,
    };
    try {
      if (isEdit && transactionId) {
        await update.mutateAsync({
          id: transactionId,
          ...payload,
          description: payload.description ?? null,
        });
      } else {
        await create.mutateAsync(payload);
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    }
  };

  const onDelete = async () => {
    if (!transactionId) return;
    await del.mutateAsync(transactionId);
    onClose();
  };

  const onPickFile = async (file: File) => {
    if (!transactionId) return;
    try {
      await upload.mutateAsync({ txId: transactionId, file });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Загрузка не удалась');
    }
  };

  return (
    <>
      <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
        <SheetContent side="right" hideClose className="sm:max-w-md">
          <SheetHeader className="flex-row items-center justify-between gap-2 space-y-0">
            <SheetTitle>{isEdit ? 'Операция' : 'Новая операция'}</SheetTitle>
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              aria-label="Закрыть"
            >
              <X className="h-4 w-4" />
            </Button>
          </SheetHeader>

          <SheetBody className="space-y-4">
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setType('EXPENSE')}
                className={cn(
                  'flex h-9 items-center justify-center rounded-md border text-sm font-medium transition-colors',
                  type === 'EXPENSE'
                    ? 'border-destructive bg-destructive text-destructive-foreground'
                    : 'border-input bg-background text-foreground hover:bg-secondary',
                )}
              >
                Расход
              </button>
              <button
                type="button"
                onClick={() => setType('INCOME')}
                className={cn(
                  'flex h-9 items-center justify-center rounded-md border text-sm font-medium transition-colors',
                  type === 'INCOME'
                    ? 'border-success bg-success text-success-foreground'
                    : 'border-input bg-background text-foreground hover:bg-secondary',
                )}
              >
                Доход
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <FormField label="Сумма" htmlFor="tx-amount" required>
                <Input
                  id="tx-amount"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00"
                  autoFocus
                />
              </FormField>
              <FormField label="Дата" htmlFor="tx-date" required>
                <Input
                  id="tx-date"
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
              </FormField>
            </div>

            <FormField label="Счёт" htmlFor="tx-account" required>
              <Select
                id="tx-account"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
              >
                <option value="" disabled>
                  — Выберите счёт —
                </option>
                {(accounts.data ?? [])
                  .filter((a: Account) => !a.isArchived)
                  .map((a: Account) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
              </Select>
            </FormField>

            <FormField label="Категория" htmlFor="tx-cat">
              <Select
                id="tx-cat"
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
              >
                <option value="">— Без категории —</option>
                {rootCats.map((root: Category) => (
                  <optgroup key={root.id} label={root.name}>
                    <option value={root.id}>{root.name} (общая)</option>
                    {childCats(root.id).map((child: Category) => (
                      <option key={child.id} value={child.id}>
                        {child.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </Select>
              {selectedCat?.isFixedCost && (
                <Badge variant="outline" className="mt-1">
                  Постоянная издержка
                </Badge>
              )}
            </FormField>

            <FormField label="Контрагент" htmlFor="tx-cp">
              <Select
                id="tx-cp"
                value={counterpartyId}
                onChange={(e) => setCounterpartyId(e.target.value)}
              >
                <option value="">— Без контрагента —</option>
                {(counterparties.data ?? [])
                  .filter((c: Counterparty) => !c.isArchived)
                  .map((c: Counterparty) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </Select>
            </FormField>

            <FormField label="Описание" htmlFor="tx-desc">
              <Input
                id="tx-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="напр. «обед, кафе»"
              />
            </FormField>

            {isEdit && transactionId && (
              <div className="space-y-1.5 pt-2">
                <div className="text-sm font-medium">Вложения</div>
                <div className="space-y-1.5">
                  {(existing.data?.attachments ?? []).map((a) => (
                    <div
                      key={a.id}
                      className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm"
                    >
                      <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <a
                        href={`/api/v1/workspaces/${wsId}/attachments/${a.id}/download`}
                        className="flex-1 truncate text-primary hover:underline"
                      >
                        {a.filename}
                      </a>
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {(a.size / 1024).toFixed(0)} KB
                      </span>
                      <button
                        type="button"
                        onClick={() => removeAtt.mutate({ id: a.id, txId: transactionId })}
                        aria-label="Удалить вложение"
                        className="text-destructive transition-colors hover:opacity-80"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                  <label className="flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-secondary">
                    <Paperclip className="h-3.5 w-3.5" />
                    Прикрепить файл
                    <input
                      type="file"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) onPickFile(f);
                        e.target.value = '';
                      }}
                    />
                  </label>
                  {upload.isPending && (
                    <p className="text-xs text-muted-foreground">Загружаю…</p>
                  )}
                </div>
              </div>
            )}

            {error && <p className="text-sm text-destructive">{error}</p>}
          </SheetBody>

          <SheetFooter>
            {isEdit && (
              <Button
                variant="destructive"
                onClick={() => setConfirmDel(true)}
                className="sm:mr-auto"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Удалить
              </Button>
            )}
            <Button variant="secondary" onClick={onClose}>
              Отмена
            </Button>
            <Button
              onClick={onSave}
              disabled={
                !amount.trim() ||
                !accountId ||
                create.isPending ||
                update.isPending
              }
            >
              {(create.isPending || update.isPending) ? 'Сохраняю…' : 'Сохранить'}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <ConfirmDialog
        open={confirmDel}
        onOpenChange={setConfirmDel}
        title="Удалить операцию?"
        description="Операцию можно восстановить из истории."
        confirmText="Удалить"
        onConfirm={onDelete}
        loading={del.isPending}
      />
    </>
  );
}
