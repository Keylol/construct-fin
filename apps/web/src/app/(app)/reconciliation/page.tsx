'use client';

import { useEffect, useState } from 'react';
import { Plus, Scale, X, Trash2 } from '@/components/ui/icons';
import { Money } from '@/components/ui/Money';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useAccounts } from '@/hooks/useAccounts';
import {
  useReconciliation,
  useBalanceChecks,
  useCreateBalanceCheck,
  useDeleteBalanceCheck,
  type CreateCheckInput,
} from '@/hooks/useReconciliation';
import type { BalanceCheck, ReconciliationReport } from '@/lib/types';

type ReconciliationOp = ReconciliationReport['unreconciled']['operations'][number];
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { KpiCard } from '@/components/ui/KpiCard';
import { EmptyState } from '@/components/ui/EmptyState';
import { FilterBar } from '@/components/ui/FilterBar';
import { FormField } from '@/components/ui/FormField';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  ModalClose,
} from '@/components/ui/Modal';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/dates';
import { fromLocalDateInput, todayInput } from '@/lib/periods';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { KpiRow } from '@/components/ui/KpiRow';
import { ErrorState } from '@/components/ui/ErrorState';
import { FilterField } from '@/components/ui/FilterField';
import { MoneyInput } from '@/components/ui/MoneyInput';
import { Checkbox } from '@/components/ui/Checkbox';

export default function ReconciliationPage() {
  const { current } = useCurrentWorkspace();
  const wsId = current?.id ?? null;
  const accounts = useAccounts(wsId);
  const today = todayInput();

  const [accountId, setAccountId] = useState<string | null>(null);
  const [asOf, setAsOf] = useState(today);
  const [creating, setCreating] = useState(false);
  const [confirmDel, setConfirmDel] = useState<BalanceCheck | null>(null);

  // Автовыбор первого активного счёта.
  useEffect(() => {
    if (!accountId && accounts.data && accounts.data.length > 0) {
      const firstActive = accounts.data.find((a) => !a.isArchived) ?? accounts.data[0];
      if (firstActive) setAccountId(firstActive.id);
    }
  }, [accounts.data, accountId]);

  const report = useReconciliation(wsId, accountId, fromLocalDateInput(asOf));
  const checks = useBalanceChecks(wsId, accountId);
  const del = useDeleteBalanceCheck(current?.id ?? '');

  if (!current) return null;

  const data = report.data;
  const discrepancy = data?.lastCheck ? Number(data.lastCheck.discrepancy) : null;

  const opColumns: Column<ReconciliationOp>[] = [
    {
      key: 'date',
      header: 'Дата',
      cell: (op) => <span className="whitespace-nowrap">{formatDate(op.date)}</span>,
      className: 'w-[120px]',
    },
    {
      key: 'description',
      header: 'Описание',
      className: 'w-full max-w-0',
      cell: (op) => <span className="block truncate text-muted-foreground">{op.description ?? '—'}</span>,
    },
    {
      key: 'amount',
      header: 'Сумма',
      align: 'right',
      cell: (op) => (
        <span className={cn('font-semibold', op.type === 'INCOME' ? 'text-success' : 'text-destructive')}>
          {op.type === 'INCOME' ? '+' : '−'}
          <Money value={op.amount} tone="plain" />
        </span>
      ),
      className: 'w-[150px]',
    },
  ];

  const checkColumns: Column<BalanceCheck>[] = [
    {
      key: 'date',
      header: 'Дата',
      cell: (c) => <span className="whitespace-nowrap">{formatDate(c.date)}</span>,
      className: 'w-[120px]',
    },
    {
      key: 'note',
      header: 'Примечание',
      className: 'w-full max-w-0',
      cell: (c) => <span className="block truncate text-muted-foreground">{c.note ?? '—'}</span>,
    },
    {
      key: 'actual',
      header: 'Факт. остаток',
      align: 'right',
      cell: (c) => <Money value={c.actualBalance} className="font-medium" />,
      className: 'w-[160px]',
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      hoverOnly: true,
      cell: (c) => (
        <Button variant="ghost" size="icon" aria-label="Удалить снимок" onClick={() => setConfirmDel(c)}>
          <Trash2 className="h-3.5 w-3.5 text-destructive" />
        </Button>
      ),
      className: 'w-[56px]',
    },
  ];

  return (
    <>
      <PageHeader
        title="Сверка"
        actions={
          <Button onClick={() => setCreating(true)} disabled={!accountId}>
            <Plus className="h-4 w-4" />
            Снимок остатка
          </Button>
        }
      />

      <FilterBar>
        <FilterField label="Счёт">
          <Select
            value={accountId ?? ''}
            onChange={(e) => setAccountId(e.target.value || null)}
            className="h-9 w-[200px]"
          >
            <option value="">Выберите счёт</option>
            {accounts.data?.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.isArchived ? ' (архив)' : ''}
              </option>
            ))}
          </Select>
        </FilterField>
        <FilterField label="На дату">
          <Input
            type="date"
            value={asOf}
            onChange={(e) => setAsOf(e.target.value)}
            className="h-9 w-[160px]"
          />
        </FilterField>
      </FilterBar>

      <div className="space-y-4 px-6 py-4">
        {!accountId ? (
          <EmptyState
            icon={Scale}
            title="Выберите счёт"
            hint="Сверка показывает расчётный остаток против снимка остатка."
          />
        ) : report.isError ? (
          <ErrorState error={report.error} onRetry={() => report.refetch()} />
        ) : (
          <>
            <KpiRow loading={report.isLoading || !data}>
              <KpiCard label="Расчётный остаток" value={<Money value={data?.computedBalance ?? '0'} />} />
              <KpiCard
                label="Последний факт"
                value={data?.lastCheck ? <Money value={data.lastCheck.actualBalance} /> : '—'}
                hint={data?.lastCheck ? `на ${formatDate(data.lastCheck.date)}` : 'снимков нет'}
              />
              <KpiCard
                label="Расхождение (факт − расчёт)"
                value={data?.lastCheck ? <Money value={data.lastCheck.discrepancy} /> : '—'}
                tone={discrepancy === null || discrepancy === 0 ? 'neutral' : 'negative'}
                hint={
                  discrepancy === null ? undefined : discrepancy === 0 ? 'сходится' : 'есть расхождение'
                }
              />
            </KpiRow>

            <section className="space-y-2">
              <div className="flex items-baseline justify-between">
                <h2 className="text-sm font-semibold text-foreground">
                  Операции после последнего снимка
                  {data?.unreconciled.since && ` (с ${formatDate(data.unreconciled.since)})`}
                </h2>
                {data && (
                  <span className="text-xs text-muted-foreground">
                    {data.unreconciled.count} шт · сальдо <Money value={data.unreconciled.net} />
                  </span>
                )}
              </div>
              <div className="rounded-md border border-border bg-card">
                <DataTable
                  data={data?.unreconciled.operations ?? []}
                  columns={opColumns}
                  rowKey={(op) => op.id}
                  loading={report.isLoading}
                  empty={
                    <p className="px-4 py-2 text-center text-sm text-muted-foreground">
                      Нет операций после снимка.
                    </p>
                  }
                  mobileCards={(op) => (
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm">{op.description ?? '—'}</div>
                        <div className="text-xs text-muted-foreground">{formatDate(op.date)}</div>
                      </div>
                      <span className={cn('font-semibold', op.type === 'INCOME' ? 'text-success' : 'text-destructive')}>
                        {op.type === 'INCOME' ? '+' : '−'}
                        <Money value={op.amount} tone="plain" />
                      </span>
                    </div>
                  )}
                />
              </div>
            </section>

            <section className="space-y-2">
              <h2 className="text-sm font-semibold text-foreground">История снимков</h2>
              <div className="rounded-md border border-border bg-card">
                <DataTable
                  data={checks.data ?? []}
                  columns={checkColumns}
                  rowKey={(c) => c.id}
                  loading={checks.isLoading}
                  error={checks.error}
                  onRetry={() => checks.refetch()}
                  empty={
                    <p className="px-4 py-2 text-center text-sm text-muted-foreground">
                      Снимков пока нет. Сделайте снимок фактического остатка по выписке.
                    </p>
                  }
                  mobileCards={(c) => (
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm">{formatDate(c.date)}</div>
                        <div className="truncate text-xs text-muted-foreground">{c.note ?? '—'}</div>
                      </div>
                      <Money value={c.actualBalance} className="font-medium" />
                    </div>
                  )}
                />
              </div>
            </section>
          </>
        )}
      </div>

      <CheckForm
        wsId={current.id}
        accountId={accountId}
        defaultDate={asOf}
        open={creating}
        onClose={() => setCreating(false)}
      />

      <ConfirmDialog
        open={!!confirmDel}
        onOpenChange={(o) => !o && setConfirmDel(null)}
        title="Удалить снимок?"
        description="Снимок будет удалён. Операции по счёту не затрагиваются."
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

function CheckForm({
  wsId,
  accountId,
  defaultDate,
  open,
  onClose,
}: {
  wsId: string;
  accountId: string | null;
  defaultDate: string;
  open: boolean;
  onClose: () => void;
}) {
  const create = useCreateBalanceCheck(wsId);
  const [error, setError] = useState<string | null>(null);
  const [date, setDate] = useState(defaultDate);
  const [actualBalance, setActualBalance] = useState('');
  const [note, setNote] = useState('');
  const [anchor, setAnchor] = useState(false);

  useEffect(() => {
    setDate(defaultDate);
    setActualBalance('');
    setNote('');
    setAnchor(false);
    setError(null);
  }, [open, defaultDate]);

  const canSave = !!accountId && actualBalance.trim() !== '' && !create.isPending;
  const dirty = actualBalance.trim() !== '' || note.trim() !== '' || anchor;

  const onSave = async () => {
    if (!accountId) return;
    setError(null);
    try {
      const input: CreateCheckInput = {
        accountId,
        date: fromLocalDateInput(date),
        actualBalance: actualBalance.replace(',', '.'),
        note: note.trim() || undefined,
        anchor: anchor || undefined,
      };
      await create.mutateAsync(input);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    }
  };

  return (
    <Modal open={open} onOpenChange={(o) => !o && onClose()} dirty={dirty}>
      <ModalContent hideClose>
        <ModalHeader className="flex-row items-center justify-between gap-2 space-y-0">
          <ModalTitle>Снимок остатка</ModalTitle>
          <ModalClose asChild>
            <Button variant="ghost" size="icon" aria-label="Закрыть">
              <X className="h-4 w-4" />
            </Button>
          </ModalClose>
        </ModalHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void onSave();
          }}
        >
        <ModalBody className="space-y-4">
          <FormField label="Дата" htmlFor="rc-date" required>
            <Input
              id="rc-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </FormField>
          <FormField label="Фактический остаток" htmlFor="rc-balance" required>
            <MoneyInput
              id="rc-balance"
              value={actualBalance}
              onChange={(e) => setActualBalance(e.target.value)}
              placeholder="по выписке / факту"
              autoFocus
            />
          </FormField>
          <FormField label="Примечание" htmlFor="rc-note">
            <Input
              id="rc-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Необязательно"
            />
          </FormField>
          {/* Счёт без API банка (карта, наличные): стартового остатка нет, и этот
              факт — единственный способ его получить. Начальный остаток счёта
              выводится так, чтобы остаток на конец дня сверки сошёлся с фактом. */}
          <Checkbox
            label="Принять как начальный остаток счёта"
            hint="Начальный остаток будет выведен из этой цифры: выписка по счёту должна быть загружена по эту дату."
            checked={anchor}
            onChange={(e) => setAnchor(e.target.checked)}
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
        </ModalBody>
        <ModalFooter>
          <ModalClose asChild>
            <Button type="button" variant="secondary">
              Отмена
            </Button>
          </ModalClose>
          <Button type="submit" loading={create.isPending} disabled={!canSave}>
            Сохранить
          </Button>
        </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}
