'use client';

import { useEffect, useMemo, useState } from 'react';
import { Plus, ArrowLeftRight, X, Trash2 } from 'lucide-react';
import { formatRub } from '@construct/shared';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useAccounts } from '@/hooks/useAccounts';
import {
  useTransfers,
  useCreateTransfer,
  useDeleteTransfer,
  type CreateTransferInput,
} from '@/hooks/useTransfers';
import type { Account, Transfer } from '@/lib/types';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { EmptyState } from '@/components/ui/EmptyState';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { FormField } from '@/components/ui/FormField';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/Sheet';

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

export default function TransfersPage() {
  const { current } = useCurrentWorkspace();
  const wsId = current?.id ?? null;
  const transfers = useTransfers(wsId);
  const accounts = useAccounts(wsId);
  const [creating, setCreating] = useState(false);
  const [confirmDel, setConfirmDel] = useState<Transfer | null>(null);
  const del = useDeleteTransfer(current?.id ?? '');

  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of accounts.data ?? []) m.set(a.id, a.name);
    return m;
  }, [accounts.data]);

  if (!current) {
    return (
      <>
        <PageHeader title="Переводы" />
        <div className="p-6">
          <EmptyState
            icon={ArrowLeftRight}
            title="Нет активного пространства"
            hint="Выберите или создайте пространство."
          />
        </div>
      </>
    );
  }

  const acc = (id: string) => nameById.get(id) ?? '—';

  const columns: Column<Transfer>[] = [
    {
      key: 'date',
      header: 'Дата',
      sortable: true,
      cell: (t) => <span className="tabular-nums">{fmtDate(t.date)}</span>,
      className: 'w-[120px]',
    },
    {
      key: 'route',
      header: 'Со счёта → на счёт',
      cell: (t) => (
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate">{acc(t.fromAccountId)}</span>
          <ArrowLeftRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{acc(t.toAccountId)}</span>
        </div>
      ),
    },
    {
      key: 'amount',
      header: 'Сумма',
      align: 'right',
      sortable: true,
      cell: (t) => <span className="tabular-nums">{formatRub(t.amount)}</span>,
      className: 'w-[140px]',
    },
    {
      key: 'fee',
      header: 'Комиссия',
      align: 'right',
      cell: (t) =>
        Number(t.fee) > 0 ? (
          <span className="tabular-nums text-destructive">{formatRub(t.fee)}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
      className: 'w-[120px]',
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (t) => (
        <Button
          variant="ghost"
          size="icon"
          aria-label="Удалить перевод"
          onClick={(e) => {
            e.stopPropagation();
            setConfirmDel(t);
          }}
        >
          <Trash2 className="h-3.5 w-3.5 text-destructive" />
        </Button>
      ),
      className: 'w-[56px]',
    },
  ];

  return (
    <>
      <PageHeader
        title="Переводы"
        breadcrumbs={[{ label: 'Учёт' }, { label: 'Переводы' }]}
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" />
            Перевод
          </Button>
        }
      />
      <div className="bg-card border-t border-border">
        <DataTable
          data={transfers.data ?? []}
          columns={columns}
          rowKey={(t) => t.id}
          loading={transfers.isLoading}
          empty={
            <EmptyState
              icon={ArrowLeftRight}
              title="Пока нет переводов"
              hint="Перевод перемещает деньги между вашими счетами и не влияет на прибыль."
              action={
                <Button onClick={() => setCreating(true)}>
                  <Plus className="h-4 w-4" /> Создать перевод
                </Button>
              }
            />
          }
          mobileCards={(t) => (
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">
                  {acc(t.fromAccountId)} → {acc(t.toAccountId)}
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                  {fmtDate(t.date)}
                  {Number(t.fee) > 0 && ` · комиссия ${formatRub(t.fee)}`}
                </div>
              </div>
              <div className="shrink-0 text-sm font-medium tabular-nums">
                {formatRub(t.amount)}
              </div>
            </div>
          )}
        />
      </div>

      <TransferForm
        wsId={current.id}
        accounts={accounts.data ?? []}
        open={creating}
        onClose={() => setCreating(false)}
      />

      <ConfirmDialog
        open={!!confirmDel}
        onOpenChange={(o) => !o && setConfirmDel(null)}
        title="Удалить перевод?"
        description="Перевод и его проводки (включая комиссию) будут отменены, остатки счетов восстановятся."
        confirmText="Удалить"
        onConfirm={async () => {
          if (confirmDel) await del.mutateAsync(confirmDel.id);
          setConfirmDel(null);
        }}
        loading={del.isPending}
      />
    </>
  );
}

function TransferForm({
  wsId,
  accounts,
  open,
  onClose,
}: {
  wsId: string;
  accounts: Account[];
  open: boolean;
  onClose: () => void;
}) {
  const create = useCreateTransfer(wsId);
  const [error, setError] = useState<string | null>(null);

  const active = accounts.filter((a) => !a.isArchived);
  const today = new Date().toISOString().slice(0, 10);

  const [fromAccountId, setFromAccountId] = useState('');
  const [toAccountId, setToAccountId] = useState('');
  const [amount, setAmount] = useState('');
  const [fee, setFee] = useState('');
  const [date, setDate] = useState(today);
  const [note, setNote] = useState('');

  useEffect(() => {
    setFromAccountId('');
    setToAccountId('');
    setAmount('');
    setFee('');
    setDate(new Date().toISOString().slice(0, 10));
    setNote('');
    setError(null);
  }, [open]);

  const sameAccount = !!fromAccountId && fromAccountId === toAccountId;
  const canSave =
    !!fromAccountId && !!toAccountId && !sameAccount && Number(amount) > 0 && !create.isPending;

  const onSave = async () => {
    setError(null);
    try {
      const input: CreateTransferInput = {
        fromAccountId,
        toAccountId,
        amount: amount.replace(',', '.'),
        fee: fee.trim() ? fee.replace(',', '.') : undefined,
        date: new Date(date).toISOString(),
        note: note.trim() || undefined,
      };
      await create.mutateAsync(input);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    }
  };

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" hideClose className="sm:max-w-md">
        <SheetHeader className="flex-row items-center justify-between gap-2 space-y-0">
          <SheetTitle>Новый перевод</SheetTitle>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Закрыть">
            <X className="h-4 w-4" />
          </Button>
        </SheetHeader>
        <SheetBody className="space-y-4">
          <FormField label="Со счёта" htmlFor="tr-from" required>
            <Select
              id="tr-from"
              value={fromAccountId}
              onChange={(e) => setFromAccountId(e.target.value)}
            >
              <option value="">Выберите счёт</option>
              {active.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="На счёт" htmlFor="tr-to" required>
            <Select
              id="tr-to"
              value={toAccountId}
              onChange={(e) => setToAccountId(e.target.value)}
            >
              <option value="">Выберите счёт</option>
              {active.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
            {sameAccount && (
              <p className="mt-1 text-xs text-destructive">Счета должны различаться.</p>
            )}
          </FormField>
          <FormField label="Сумма" htmlFor="tr-amount" required>
            <Input
              id="tr-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              autoFocus
            />
          </FormField>
          <FormField label="Комиссия" htmlFor="tr-fee">
            <Input
              id="tr-fee"
              inputMode="decimal"
              value={fee}
              onChange={(e) => setFee(e.target.value)}
              placeholder="0.00 — расход на счёте-источнике"
            />
          </FormField>
          <FormField label="Дата" htmlFor="tr-date" required>
            <Input
              id="tr-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </FormField>
          <FormField label="Заметка" htmlFor="tr-note">
            <Input
              id="tr-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="опционально"
            />
          </FormField>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </SheetBody>
        <SheetFooter>
          <Button variant="secondary" onClick={onClose}>
            Отмена
          </Button>
          <Button onClick={onSave} disabled={!canSave}>
            {create.isPending ? 'Создаю…' : 'Создать'}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
