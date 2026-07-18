'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { formatRub } from '@construct/shared';
import { Calculator, ChevronLeft, ChevronRight, Check } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { MoneyInput } from '@/components/ui/MoneyInput';
import { EmptyState } from '@/components/ui/EmptyState';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { Skeleton } from '@/components/ui/Skeleton';
import { toast } from '@/components/ui/Toaster';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useAccounts } from '@/hooks/useAccounts';
import { useTaxReport, usePayTax } from '@/hooks/useTax';
import type { TaxMonthRow } from '@/lib/types';
import { formatDate } from '@/lib/dates';
import { cn } from '@/lib/cn';

const MONTH_NAMES = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];

const STATUS_META: Record<TaxMonthRow['status'], { label: string; cls: string }> = {
  PAID: { label: 'уплачен', cls: 'bg-success/15 text-success' },
  PARTIAL: { label: 'частично', cls: 'bg-warning/15 text-warning' },
  UNPAID: { label: 'к уплате', cls: 'bg-destructive/15 text-destructive' },
  NONE: { label: '—', cls: 'bg-secondary text-muted-foreground' },
};

/** Диапазон [from,to) месяца в ISO для drill-down в операции (по бизнес-дате). */
function monthRange(year: number, monthNo: number): { from: string; to: string } {
  const from = new Date(Date.UTC(year, monthNo - 1, 1));
  const to = new Date(Date.UTC(year, monthNo, 0, 23, 59, 59));
  return { from: from.toISOString(), to: to.toISOString() };
}

export default function TaxPage() {
  const { current } = useCurrentWorkspace();
  const wsId = current?.id ?? null;
  const [year, setYear] = useState(() => new Date().getUTCFullYear());
  const report = useTaxReport(wsId, year);
  const [payFor, setPayFor] = useState<TaxMonthRow | null>(null);

  if (!current) {
    return (
      <>
        <PageHeader title="Налог" />
        <div className="p-6">
          <EmptyState icon={Calculator} title="Нет активного пространства" hint="Выберите пространство." />
        </div>
      </>
    );
  }

  const rep = report.data;

  return (
    <>
      <PageHeader
        title="Налог (АУСН Д−Р)"
        breadcrumbs={[{ label: 'Аналитика' }, { label: 'Налог' }]}
        actions={
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={() => setYear((y) => y - 1)} aria-label="Предыдущий год">
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="min-w-14 text-center text-sm font-medium tabular-nums">{year}</span>
            <Button variant="ghost" size="sm" onClick={() => setYear((y) => y + 1)} aria-label="Следующий год">
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        }
      />
      <div className="space-y-4 px-6 py-4">
        <p className="max-w-3xl text-sm text-muted-foreground">
          Налог считается сам по операциям: доход и расход по кассовому методу,
          20% с базы (доходы−расходы), минимум 3% с доходов, срок уплаты — до 25-го
          следующего месяца. Маркировку операции (доход/расход/не учитывать) можно
          поправить в карточке операции.
        </p>

        {report.isLoading ? (
          <Skeleton className="h-96" />
        ) : !rep ? (
          <EmptyState icon={Calculator} title="Нет данных" hint="Не удалось загрузить расчёт." />
        ) : (
          <Card className="overflow-x-auto p-0">
            <table className="w-full min-w-[860px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Месяц</th>
                  <th className="px-3 py-2 text-right font-medium">Доход</th>
                  <th className="px-3 py-2 text-right font-medium">Расход</th>
                  <th className="px-3 py-2 text-right font-medium">База</th>
                  <th className="px-3 py-2 text-right font-medium">Налог 20%</th>
                  <th className="px-3 py-2 text-right font-medium">Мин. 3%</th>
                  <th className="px-3 py-2 text-right font-medium">К уплате</th>
                  <th className="px-3 py-2 text-right font-medium">Уплачено</th>
                  <th className="px-3 py-2 font-medium">Срок</th>
                  <th className="px-3 py-2 font-medium">Статус</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {rep.months.map((m) => {
                  const range = monthRange(m.year, m.monthNo);
                  const status = STATUS_META[m.status];
                  const empty = m.status === 'NONE' && m.incomeCount === 0 && m.expenseCount === 0;
                  return (
                    <tr
                      key={m.month}
                      className={cn('border-b border-border/60', empty && 'text-muted-foreground')}
                    >
                      <td className="whitespace-nowrap px-3 py-2 font-medium">{MONTH_NAMES[m.monthNo - 1]}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        <Link
                          href={`/transactions?from=${range.from}&to=${range.to}&type=INCOME` as Parameters<typeof Link>[0]['href']}
                          className="hover:text-primary hover:underline"
                        >
                          {formatRub(m.income, 2)}
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        <Link
                          href={`/transactions?from=${range.from}&to=${range.to}&type=EXPENSE` as Parameters<typeof Link>[0]['href']}
                          className="hover:text-primary hover:underline"
                        >
                          {formatRub(m.expense, 2)}
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatRub(m.base, 2)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{formatRub(m.taxCalc, 2)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{formatRub(m.taxMin, 2)}</td>
                      <td className="px-3 py-2 text-right font-semibold tabular-nums">{formatRub(m.taxDue, 2)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatRub(m.taxPaid, 2)}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">
                        {formatDate(m.dueDate)}
                      </td>
                      <td className="px-3 py-2">
                        <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', status.cls)}>
                          {status.label}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right">
                        {(m.status === 'UNPAID' || m.status === 'PARTIAL') && (
                          <Button variant="ghost" size="sm" onClick={() => setPayFor(m)}>
                            Уплатить
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t border-border font-semibold">
                  <td className="px-3 py-2">Год</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatRub(rep.totals.income, 2)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatRub(rep.totals.expense, 2)}</td>
                  <td colSpan={3} />
                  <td className="px-3 py-2 text-right tabular-nums">{formatRub(rep.totals.taxDue, 2)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatRub(rep.totals.taxPaid, 2)}</td>
                  <td colSpan={3} />
                </tr>
              </tfoot>
            </table>
          </Card>
        )}
      </div>

      {payFor && (
        <PayDialog
          wsId={current.id}
          row={payFor}
          onClose={() => setPayFor(null)}
        />
      )}
    </>
  );
}

function PayDialog({
  wsId,
  row,
  onClose,
}: {
  wsId: string;
  row: TaxMonthRow;
  onClose: () => void;
}) {
  const accounts = useAccounts(wsId);
  const pay = usePayTax(wsId);
  const [accountId, setAccountId] = useState('');
  // Остаток к доплате = к уплате − уже уплачено.
  const remaining = (Number(row.taxDue) - Number(row.taxPaid)).toFixed(2);
  const [amount, setAmount] = useState(remaining);
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));

  const accountOptions = useMemo<ComboboxOption[]>(
    () => (accounts.data ?? []).map((a) => ({ value: a.id, label: a.name })),
    [accounts.data],
  );

  const valid = !!accountId && /^\d+(\.\d{1,2})?$/.test(amount) && Number(amount) > 0 && !!date;

  const submit = () => {
    if (!valid) return;
    pay.mutate(
      {
        year: row.year,
        month: row.monthNo,
        accountId,
        amount,
        date: new Date(`${date}T12:00:00.000Z`).toISOString(),
      },
      {
        onSuccess: () => {
          toast.success('Уплата налога отмечена');
          onClose();
        },
        onError: (e) => toast.error(e instanceof Error ? e.message : 'Не удалось отметить уплату'),
      },
    );
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[420px]">
        <DialogHeader>
          <DialogTitle>Уплата налога за {MONTH_NAMES[row.monthNo - 1]} {row.year}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="rounded-md bg-secondary/40 p-3 text-sm">
            К уплате <b className="tabular-nums">{formatRub(row.taxDue, 2)}</b>
            {Number(row.taxPaid) > 0 && (
              <> · уже уплачено {formatRub(row.taxPaid, 2)}</>
            )}
          </div>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            <span>Счёт списания</span>
            <Combobox
              value={accountId}
              onChange={setAccountId}
              options={accountOptions}
              placeholder="Выберите счёт"
              searchPlaceholder="Счёт…"
              className="h-9"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            <span>Сумма</span>
            <MoneyInput value={amount} onChange={(e) => setAmount(e.target.value)} className="h-9" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            <span>Дата уплаты</span>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="h-9" />
          </label>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>Отмена</Button>
          <Button onClick={submit} disabled={!valid || pay.isPending}>
            <Check className="h-4 w-4" />
            {pay.isPending ? 'Сохранение…' : 'Отметить уплату'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
