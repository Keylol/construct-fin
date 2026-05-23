'use client';

import { useEffect, useState } from 'react';
import type { Transaction, TxType, Account, Category, Counterparty } from '@/lib/types';
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
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Select } from '@/components/ui/Select';
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
  const childCats = (parentId: string) => cats.filter((c) => c.parentId === parentId && !c.isArchived);
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
        await update.mutateAsync({ id: transactionId, ...payload, description: payload.description ?? null });
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
    if (!confirm('Удалить операцию?')) return;
    try {
      await del.mutateAsync(transactionId);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    }
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
    <Modal open={open} onClose={onClose} title={isEdit ? 'Операция' : 'Новая операция'}>
      <div className="space-y-3">
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setType('EXPENSE')}
            className={`flex-1 h-10 rounded-xl text-sm font-medium transition ${
              type === 'EXPENSE' ? 'bg-danger text-white' : 'bg-surface border border-white/10 text-fg/70'
            }`}
          >
            Расход
          </button>
          <button
            type="button"
            onClick={() => setType('INCOME')}
            className={`flex-1 h-10 rounded-xl text-sm font-medium transition ${
              type === 'INCOME' ? 'bg-success text-white' : 'bg-surface border border-white/10 text-fg/70'
            }`}
          >
            Доход
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="tx-amount">Сумма</Label>
            <Input
              id="tx-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              autoFocus
            />
          </div>
          <div>
            <Label htmlFor="tx-date">Дата</Label>
            <Input id="tx-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
        </div>

        <div>
          <Label htmlFor="tx-account">Счёт</Label>
          <Select id="tx-account" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="" disabled>— Выберите счёт —</option>
            {(accounts.data ?? [])
              .filter((a: Account) => !a.isArchived)
              .map((a: Account) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </Select>
        </div>

        <div>
          <Label htmlFor="tx-cat">Категория</Label>
          <Select id="tx-cat" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
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
            <p className="text-xs text-tint mt-1">Постоянная издержка</p>
          )}
        </div>

        <div>
          <Label htmlFor="tx-cp">Контрагент</Label>
          <Select id="tx-cp" value={counterpartyId} onChange={(e) => setCounterpartyId(e.target.value)}>
            <option value="">— Без контрагента —</option>
            {(counterparties.data ?? [])
              .filter((c: Counterparty) => !c.isArchived)
              .map((c: Counterparty) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </Select>
        </div>

        <div>
          <Label htmlFor="tx-desc">Описание</Label>
          <Input
            id="tx-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="напр. «обед, кафе»"
          />
        </div>

        {isEdit && transactionId && (
          <div className="pt-2">
            <Label>Вложения</Label>
            <div className="space-y-1.5">
              {(existing.data?.attachments ?? []).map((a) => (
                <div
                  key={a.id}
                  className="flex items-center gap-2 px-3 py-2 rounded-xl bg-surface border border-white/10 text-sm"
                >
                  <a
                    href={`/api/v1/workspaces/${wsId}/attachments/${a.id}/download`}
                    className="flex-1 truncate text-tint hover:underline"
                  >
                    {a.filename}
                  </a>
                  <span className="text-xs text-muted">{(a.size / 1024).toFixed(0)} KB</span>
                  <button
                    type="button"
                    onClick={() => removeAtt.mutate({ id: a.id, txId: transactionId })}
                    className="text-danger text-xs hover:underline"
                  >
                    удалить
                  </button>
                </div>
              ))}
              <label className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-dashed border-white/20 text-sm text-muted hover:bg-glass/40 cursor-pointer">
                + Прикрепить файл
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
              {upload.isPending && <p className="text-xs text-muted">Загружаю…</p>}
            </div>
          </div>
        )}

        {error && <p className="text-danger text-sm">{error}</p>}

        <div className="flex gap-2 pt-2">
          {isEdit && <Button variant="danger" onClick={onDelete} className="flex-1">Удалить</Button>}
          <Button variant="secondary" onClick={onClose} className="flex-1">Отмена</Button>
          <Button
            onClick={onSave}
            disabled={!amount.trim() || !accountId || create.isPending || update.isPending}
            className="flex-1"
          >
            Сохранить
          </Button>
        </div>
      </div>
    </Modal>
  );
}
