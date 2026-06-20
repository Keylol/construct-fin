'use client';

import { useEffect, useState } from 'react';
import { Plus, Scale, X, Trash2 } from '@/components/ui/icons';
import { formatRub } from '@construct/shared';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useAccounts } from '@/hooks/useAccounts';
import {
  useReconciliation,
  useBalanceChecks,
  useCreateBalanceCheck,
  useDeleteBalanceCheck,
  type CreateCheckInput,
} from '@/hooks/useReconciliation';
import type { BalanceCheck } from '@/lib/types';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Card } from '@/components/ui/Card';
import { KpiCard } from '@/components/ui/KpiCard';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { FilterBar } from '@/components/ui/FilterBar';
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
import { cn } from '@/lib/cn';

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

export default function ReconciliationPage() {
  const { current } = useCurrentWorkspace();
  const wsId = current?.id ?? null;
  const accounts = useAccounts(wsId);
  const today = new Date().toISOString().slice(0, 10);

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

  const report = useReconciliation(wsId, accountId, new Date(asOf).toISOString());
  const checks = useBalanceChecks(wsId, accountId);
  const del = useDeleteBalanceCheck(current?.id ?? '');

  if (!current) {
    return (
      <>
        <PageHeader title="Сверка счетов" />
        <div className="p-6">
          <EmptyState
            icon={Scale}
            title="Нет активного пространства"
            hint="Выберите или создайте пространство."
          />
        </div>
      </>
    );
  }

  const data = report.data;
  const discrepancy = data?.lastCheck ? Number(data.lastCheck.discrepancy) : null;

  return (
    <>
      <PageHeader
        title="Сверка счетов"
        breadcrumbs={[{ label: 'Аналитика' }, { label: 'Сверка' }]}
        actions={
          <Button onClick={() => setCreating(true)} disabled={!accountId}>
            <Plus className="h-4 w-4" />
            Зафиксировать остаток
          </Button>
        }
      />

      <FilterBar>
        <label className="flex flex-col text-xs text-muted-foreground">
          <span className="pb-1">Счёт</span>
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
        </label>
        <label className="flex flex-col text-xs text-muted-foreground">
          <span className="pb-1">На дату</span>
          <Input
            type="date"
            value={asOf}
            onChange={(e) => setAsOf(e.target.value)}
            className="h-9 w-[160px]"
          />
        </label>
      </FilterBar>

      <div className="space-y-4 px-6 py-4">
        {!accountId ? (
          <EmptyState
            icon={Scale}
            title="Выберите счёт"
            hint="Сверка показывает расчётный остаток против зафиксированного факта."
          />
        ) : report.isLoading ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <Skeleton className="h-[88px]" />
            <Skeleton className="h-[88px]" />
            <Skeleton className="h-[88px]" />
          </div>
        ) : report.isError ? (
          <p className="text-sm text-destructive">Не удалось загрузить сверку.</p>
        ) : data ? (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <KpiCard label="Расчётный остаток" value={formatRub(data.computedBalance)} />
              <KpiCard
                label="Последний факт"
                value={data.lastCheck ? formatRub(data.lastCheck.actualBalance) : '—'}
                hint={data.lastCheck ? `на ${fmtDate(data.lastCheck.date)}` : 'снимков нет'}
              />
              <KpiCard
                label="Расхождение (факт − расчёт)"
                value={discrepancy === null ? '—' : formatRub(data.lastCheck!.discrepancy)}
                tone={
                  discrepancy === null || discrepancy === 0
                    ? 'neutral'
                    : 'negative'
                }
                hint={
                  discrepancy === null
                    ? undefined
                    : discrepancy === 0
                      ? 'сходится'
                      : 'есть расхождение'
                }
              />
            </div>

            <Card className="!p-0 overflow-hidden">
              <header className="flex items-baseline justify-between border-b border-border px-4 py-3">
                <h3 className="font-medium">
                  Операции после последнего снимка
                  {data.unreconciled.since && ` (с ${fmtDate(data.unreconciled.since)})`}
                </h3>
                <span className="text-xs text-muted-foreground">
                  {data.unreconciled.count} шт · сальдо{' '}
                  <span className="tabular-nums">{formatRub(data.unreconciled.net)}</span>
                </span>
              </header>
              {data.unreconciled.operations.length === 0 ? (
                <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                  Нет операций после снимка.
                </p>
              ) : (
                <table className="w-full text-sm">
                  <thead className="border-b border-border">
                    <tr className="text-left text-xs uppercase text-muted-foreground">
                      <th className="px-4 py-2 font-medium">Дата</th>
                      <th className="px-4 py-2 font-medium">Описание</th>
                      <th className="px-4 py-2 text-right font-medium">Сумма</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.unreconciled.operations.map((op) => (
                      <tr key={op.id} className="border-b border-border last:border-0">
                        <td className="px-4 py-2 tabular-nums">{fmtDate(op.date)}</td>
                        <td className="px-4 py-2 text-muted-foreground">
                          {op.description ?? '—'}
                        </td>
                        <td
                          className={cn(
                            'px-4 py-2 text-right tabular-nums',
                            op.type === 'INCOME' ? 'text-success' : 'text-destructive',
                          )}
                        >
                          {op.type === 'INCOME' ? '+' : '−'}
                          {formatRub(op.amount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>

            <Card className="!p-0 overflow-hidden">
              <header className="border-b border-border px-4 py-3 font-medium">
                История снимков
              </header>
              {checks.data && checks.data.length > 0 ? (
                <table className="w-full text-sm">
                  <thead className="border-b border-border">
                    <tr className="text-left text-xs uppercase text-muted-foreground">
                      <th className="px-4 py-2 font-medium">Дата</th>
                      <th className="px-4 py-2 font-medium">Примечание</th>
                      <th className="px-4 py-2 text-right font-medium">Факт. остаток</th>
                      <th className="w-[56px] px-4 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {checks.data.map((c) => (
                      <tr key={c.id} className="border-b border-border last:border-0">
                        <td className="px-4 py-2 tabular-nums">{fmtDate(c.date)}</td>
                        <td className="px-4 py-2 text-muted-foreground">{c.note ?? '—'}</td>
                        <td className="px-4 py-2 text-right font-medium tabular-nums">
                          {formatRub(c.actualBalance)}
                        </td>
                        <td className="px-4 py-2 text-right">
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label="Удалить снимок"
                            onClick={() => setConfirmDel(c)}
                          >
                            <Trash2 className="h-3.5 w-3.5 text-destructive" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                  Снимков пока нет. Зафиксируйте фактический остаток по выписке.
                </p>
              )}
            </Card>
          </>
        ) : null}
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
        description="Зафиксированный остаток будет удалён. Операции по счёту не затрагиваются."
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

  useEffect(() => {
    setDate(defaultDate);
    setActualBalance('');
    setNote('');
    setError(null);
  }, [open, defaultDate]);

  const canSave = !!accountId && actualBalance.trim() !== '' && !create.isPending;

  const onSave = async () => {
    if (!accountId) return;
    setError(null);
    try {
      const input: CreateCheckInput = {
        accountId,
        date: new Date(date).toISOString(),
        actualBalance: actualBalance.replace(',', '.'),
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
          <SheetTitle>Зафиксировать остаток</SheetTitle>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Закрыть">
            <X className="h-4 w-4" />
          </Button>
        </SheetHeader>
        <SheetBody className="space-y-4">
          <FormField label="Дата" htmlFor="rc-date" required>
            <Input
              id="rc-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </FormField>
          <FormField label="Фактический остаток" htmlFor="rc-balance" required>
            <Input
              id="rc-balance"
              inputMode="decimal"
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
            {create.isPending ? 'Сохраняю…' : 'Сохранить'}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
