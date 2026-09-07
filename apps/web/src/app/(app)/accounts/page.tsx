'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Plus, Wallet, X, Trash2 } from '@/components/ui/icons';
import { Money } from '@/components/ui/Money';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import {
  useAccounts,
  useAccountBalances,
  useCreateAccount,
  useUpdateAccount,
  useDeleteAccount,
  type CreateAccountInput,
} from '@/hooks/useAccounts';
import type { Account, AccountType } from '@/lib/types';
import { formatDateTime } from '@/lib/dates';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { StatusDot } from '@/components/ui/StatusDot';
import { EmptyState } from '@/components/ui/EmptyState';
import { DataTable, type Column } from '@/components/ui/DataTable';
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
import { D, add, toMoneyString } from '@construct/shared';
import { plural } from '@/lib/plural';
import { ACCOUNT_TYPE_LABEL } from '@/lib/labels';
import { Checkbox } from '@/components/ui/Checkbox';
import { MoneyInput } from '@/components/ui/MoneyInput';
import { useListHotkeys } from '@/hooks/useListHotkeys';

export default function AccountsPage() {
  const { current } = useCurrentWorkspace();
  const wsId = current?.id ?? null;
  const accounts = useAccounts(wsId);
  // Текущие остатки (начальный + все движения) — считает бэкенд через ОДДС.
  const balances = useAccountBalances(wsId);
  const [editing, setEditing] = useState<Account | null>(null);
  const [creating, setCreating] = useState(false);
  // «n» — новый счёт: список короткий, поиска нет.
  useListHotkeys({ onNew: () => setCreating(true) });

  // Итоги по активным счетам (Decimal, не number): «по банку ?? по учёту» —
  // главное число, рядом — сколько строк ждёт разбора и «по учёту» целиком.
  const totals = (() => {
    if (!balances.data || !accounts.data) return null;
    let total = D(0);
    let ledger = D(0);
    let unresolvedNet = D(0);
    let unresolvedCount = 0;
    let hasBank = false;
    for (const a of accounts.data) {
      if (a.isArchived) continue;
      const b = balances.data.get(a.id);
      if (!b) continue;
      total = add(total, D(b.bank ?? b.ledger));
      ledger = add(ledger, D(b.ledger));
      unresolvedNet = add(unresolvedNet, D(b.unresolvedNet));
      unresolvedCount += b.unresolvedCount;
      if (b.bank != null) hasBank = true;
    }
    return {
      total: toMoneyString(total),
      ledger: toMoneyString(ledger),
      unresolvedNet: toMoneyString(unresolvedNet),
      unresolvedCount,
      hasBank,
    };
  })();

  if (!current) return null;

  const columns: Column<Account>[] = [
    {
      key: 'name',
      header: 'Название',
      cell: (a) => (
        <div className="min-w-0">
          <div className="truncate font-medium text-foreground">{a.name}</div>
          {a.note && (
            <div className="truncate text-xs text-muted-foreground">{a.note}</div>
          )}
        </div>
      ),
    },
    {
      key: 'type',
      header: 'Тип',
      cell: (a) => <span className="text-muted-foreground">{ACCOUNT_TYPE_LABEL[a.type]}</span>,
      className: 'w-[140px]',
    },
    {
      key: 'status',
      header: 'Статус',
      // №15: точка + текст вместо пилюли.
      cell: (a) => (
        <StatusDot tone={a.isArchived ? 'muted' : 'success'} label={a.isArchived ? 'В архиве' : 'Активен'} />
      ),
      className: 'w-[120px]',
    },
    {
      key: 'opening',
      header: 'Начальный остаток',
      align: 'right',
      cell: (a) => (
        <span
          className="text-muted-foreground"
          title={
            a.openingAnchoredAt
              ? `Выведен из остатка банка/сверки ${formatDateTime(a.openingAnchoredAt)}`
              : 'Введён вручную'
          }
        >
          <Money value={a.openingBalance} />
          {a.openingAnchoredAt && <span className="ml-1 text-[10px] uppercase">авто</span>}
        </span>
      ),
      className: 'w-[160px]',
    },
    {
      // Число, не зависящее от разбора: банк провёл всё, что провёл.
      key: 'bank',
      header: 'По банку',
      align: 'right',
      cell: (a) => {
        const b = balances.data?.get(a.id);
        if (!b) return <span className="text-muted-foreground">…</span>;
        if (b.bank == null) return <span className="text-muted-foreground">—</span>;
        return (
          <span title={b.bankAt ? `На ${formatDateTime(b.bankAt)}` : undefined}>
            <Money value={b.bank} className="font-semibold" />
          </span>
        );
      },
      className: 'w-[150px]',
    },
    {
      // Деньги, которые уже в банке, но ещё не в учёте — задача, а не ошибка.
      key: 'unresolved',
      header: 'Не разобрано',
      align: 'right',
      cell: (a) => {
        const b = balances.data?.get(a.id);
        if (!b || b.unresolvedCount === 0) return <span className="text-muted-foreground">—</span>;
        return (
          <Link
            href="/inbox"
            className="inline-flex flex-col items-end leading-tight hover:underline"
            title="Открыть «Входящие»"
            onClick={(e) => e.stopPropagation()}
          >
            <Money value={b.unresolvedNet} />
            <span className="text-[10px] text-muted-foreground">
              {b.unresolvedCount} {plural(b.unresolvedCount, 'строка', 'строки', 'строк')}
            </span>
          </Link>
        );
      },
      className: 'w-[140px]',
    },
    {
      // Начальный + проводки. Сходится с банком, когда очередь пуста.
      key: 'ledger',
      header: 'По учёту',
      align: 'right',
      cell: (a) => {
        const b = balances.data?.get(a.id);
        return b ? (
          <Money value={b.ledger} className={b.bank == null ? 'font-semibold' : undefined} />
        ) : (
          <span className="text-muted-foreground">…</span>
        );
      },
      className: 'w-[150px]',
    },
    {
      // Что осталось необъяснённым после очереди: «не учитывать», ручные
      // проводки без банка, операции в пути. Ноль — учёт сошёлся с банком.
      key: 'discrepancy',
      header: 'Расхождение',
      align: 'right',
      cell: (a) => {
        const b = balances.data?.get(a.id);
        if (!b || b.discrepancy == null) return <span className="text-muted-foreground">—</span>;
        const zero = D(b.discrepancy).isZero();
        return (
          <span
            className={zero ? 'text-muted-foreground' : 'text-warning'}
            title="По банку − по учёту − не разобрано"
          >
            <Money value={b.discrepancy} tone={zero ? 'plain' : 'auto'} />
          </span>
        );
      },
      className: 'w-[140px]',
    },
  ];

  return (
    <>
      <PageHeader
        title="Счета"
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" />
            Добавить
          </Button>
        }
      />
      {totals != null && (
        <div className="flex flex-wrap items-end justify-between gap-4 border-t border-border bg-card px-6 py-4">
          <div>
            <div className="text-sm text-muted-foreground">
              {totals.hasBank
                ? 'Денежные средства по банку (активные счета)'
                : 'Итого денежных средств (активные счета)'}
            </div>
            {/* Display-цифра (решение №7): главная сумма экрана видна через комнату. */}
            <Money value={totals.total} className="text-3xl font-semibold sm:text-4xl" />
          </div>
          {totals.hasBank && (
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
              <dt className="text-muted-foreground">По учёту</dt>
              <dd className="text-right"><Money value={totals.ledger} /></dd>
              <dt className="text-muted-foreground">
                Не разобрано
                {totals.unresolvedCount > 0 && (
                  <span className="ml-1 text-xs">
                    ({totals.unresolvedCount}{' '}
                    {plural(totals.unresolvedCount, 'строка', 'строки', 'строк')})
                  </span>
                )}
              </dt>
              <dd className="text-right">
                {totals.unresolvedCount > 0 ? (
                  <Link href="/inbox" className="hover:underline">
                    <Money value={totals.unresolvedNet} />
                  </Link>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </dd>
            </dl>
          )}
        </div>
      )}
      <div className="bg-card border-t border-border">
        <DataTable
          data={accounts.data ?? []}
          columns={columns}
          rowKey={(a) => a.id}
          onRowClick={(a) => setEditing(a)}
          loading={accounts.isLoading}
          error={accounts.error}
          onRetry={() => void accounts.refetch()}
          empty={
            <EmptyState
              icon={Wallet}
              title="Пока нет счетов"
              hint="Добавьте первый счёт — наличные или счёт в банке."
              action={
                <Button onClick={() => setCreating(true)}>
                  <Plus className="h-4 w-4" /> Добавить счёт
                </Button>
              }
            />
          }
          mobileCards={(a) => (
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate font-medium">{a.name}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {ACCOUNT_TYPE_LABEL[a.type]}
                  {a.isArchived && ' · в архиве'}
                </div>
              </div>
              <div className="shrink-0 text-right">
                {(() => {
                  const b = balances.data?.get(a.id);
                  return (
                    <>
                      <div className="text-[10px] uppercase text-muted-foreground">
                        {b?.bank != null ? 'По банку' : 'Остаток'}
                      </div>
                      <div className="text-sm font-medium">
                        <Money value={b ? (b.bank ?? b.ledger) : a.openingBalance} />
                      </div>
                      {b && b.unresolvedCount > 0 && (
                        <div className="text-[10px] text-muted-foreground">
                          не разобрано {b.unresolvedCount}
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
            </div>
          )}
        />
      </div>

      <AccountForm
        wsId={current.id}
        open={creating || !!editing}
        initial={editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
      />
    </>
  );
}

function AccountForm({
  wsId,
  open,
  initial,
  onClose,
}: {
  wsId: string;
  open: boolean;
  initial: Account | null;
  onClose: () => void;
}) {
  const create = useCreateAccount(wsId);
  const update = useUpdateAccount(wsId);
  const del = useDeleteAccount(wsId);
  const [error, setError] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);

  const [name, setName] = useState(initial?.name ?? '');
  const [type, setType] = useState<AccountType>(initial?.type ?? 'BANK');
  const [openingBalance, setOpeningBalance] = useState(initial?.openingBalance ?? '0');
  const [note, setNote] = useState(initial?.note ?? '');
  const [isArchived, setIsArchived] = useState(initial?.isArchived ?? false);

  useEffect(() => {
    if (initial) {
      setName(initial.name);
      setType(initial.type);
      setOpeningBalance(initial.openingBalance);
      setNote(initial.note ?? '');
      setIsArchived(initial.isArchived);
    } else {
      setName('');
      setType('BANK');
      setOpeningBalance('0');
      setNote('');
      setIsArchived(false);
    }
    setError(null);
  }, [initial, open]);

  // Несохранённый ввод — против значений, с которыми форма открылась.
  const dirty =
    name !== (initial?.name ?? '') ||
    type !== (initial?.type ?? 'BANK') ||
    openingBalance !== (initial?.openingBalance ?? '0') ||
    note !== (initial?.note ?? '') ||
    isArchived !== (initial?.isArchived ?? false);

  const onSave = async () => {
    setError(null);
    try {
      const input: CreateAccountInput = {
        name: name.trim(),
        type,
        openingBalance: openingBalance.replace(',', '.'),
        note: note.trim() || undefined,
      };
      if (initial) {
        await update.mutateAsync({ id: initial.id, ...input, isArchived });
      } else {
        await create.mutateAsync(input);
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    }
  };

  const onDelete = async () => {
    if (!initial) return;
    await del.mutateAsync(initial.id);
    onClose();
  };

  return (
    <>
      <Modal open={open} onOpenChange={(o) => !o && onClose()} dirty={dirty}>
        <ModalContent hideClose>
          <ModalHeader className="flex-row items-center justify-between gap-2 space-y-0">
            <ModalTitle>{initial ? 'Редактировать счёт' : 'Новый счёт'}</ModalTitle>
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
            <FormField label="Название" htmlFor="acc-name" required>
              <Input
                id="acc-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Альфа-Банк ИП"
                autoFocus
              />
            </FormField>
            <FormField label="Тип" htmlFor="acc-type">
              <Select
                id="acc-type"
                value={type}
                onChange={(e) => setType(e.target.value as AccountType)}
              >
                <option value="CASH">Наличные</option>
                <option value="BANK">Банк</option>
                <option value="OTHER">Другое</option>
              </Select>
            </FormField>
            <FormField label="Начальный остаток" htmlFor="acc-opening">
              <MoneyInput
                id="acc-opening"
                value={openingBalance}
                onChange={(e) => setOpeningBalance(e.target.value)}
                placeholder="0.00"
              />
            </FormField>
            <FormField label="Примечание" htmlFor="acc-note">
              <Input
                id="acc-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="необязательно"
              />
            </FormField>
            {initial && (
              <Checkbox label="В архиве" checked={isArchived} onChange={(e) => setIsArchived(e.target.checked)} />
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
          </ModalBody>
          <ModalFooter>
            {initial && (
              <Button
                type="button"
                variant="destructive"
                onClick={() => setConfirmDel(true)}
                className="sm:mr-auto"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Удалить
              </Button>
            )}
            <ModalClose asChild>
              <Button type="button" variant="secondary">
                Отмена
              </Button>
            </ModalClose>
            <Button
              type="submit"
              loading={create.isPending || update.isPending}
              disabled={!name.trim()}
            >
              Сохранить
            </Button>
          </ModalFooter>
          </form>
        </ModalContent>
      </Modal>
      <ConfirmDialog
        open={confirmDel}
        onOpenChange={setConfirmDel}
        title={`Архивировать «${initial?.name ?? ''}»?`}
        description="Счёт переместится в архив, операции по нему останутся."
        confirmText="В архив"
        onConfirm={onDelete}
        loading={del.isPending}
      />
    </>
  );
}
