'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { D, sub, toMoneyString } from '@construct/shared';
import { Calculator, Check } from '@/components/ui/icons';
import { Money } from '@/components/ui/Money';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { MoneyInput } from '@/components/ui/MoneyInput';
import { EmptyState } from '@/components/ui/EmptyState';
import { StatusDot } from '@/components/ui/StatusDot';
import { Select } from '@/components/ui/Select';
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
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useAccounts } from '@/hooks/useAccounts';
import { useTaxReport, usePayTax } from '@/hooks/useTax';
import type { TaxMonthRow } from '@/lib/types';
import { formatDate } from '@/lib/dates';
import { cn } from '@/lib/cn';
import { fromLocalDateInput, todayInput } from '@/lib/periods';
import { MONTH_NAMES } from '@/lib/labels';
import { FormField } from '@/components/ui/FormField';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { FilterBar } from '@/components/ui/FilterBar';
import { FilterField } from '@/components/ui/FilterField';

const STATUS_META: Record<
  TaxMonthRow['status'],
  { label: string; tone: 'success' | 'warning' | 'destructive' | 'muted' }
> = {
  PAID: { label: 'уплачен', tone: 'success' },
  PARTIAL: { label: 'частично', tone: 'warning' },
  UNPAID: { label: 'не уплачен', tone: 'destructive' },
  NONE: { label: '—', tone: 'muted' },
};

/** Диапазон [from,to) месяца в ISO для drill-down в операции (по бизнес-дате). */
function monthRange(year: number, monthNo: number): { from: string; to: string } {
  const from = new Date(Date.UTC(year, monthNo - 1, 1));
  const to = new Date(Date.UTC(year, monthNo, 0, 23, 59, 59));
  return { from: from.toISOString(), to: to.toISOString() };
}

/** Годы для выбора: текущий и пять назад — глубже архивов нет. */
const YEARS = Array.from({ length: 6 }, (_, i) => new Date().getFullYear() - i);

export default function TaxPage() {
  const { current } = useCurrentWorkspace();
  const wsId = current?.id ?? null;
  const [year, setYear] = useState(() => new Date().getUTCFullYear());
  const report = useTaxReport(wsId, year);
  const [payFor, setPayFor] = useState<TaxMonthRow | null>(null);

  if (!current) return null;

  const rep = report.data;

  const columns: Column<TaxMonthRow>[] = [
    {
      key: 'month',
      header: 'Месяц',
      cell: (m) => {
        const empty = m.status === 'NONE' && m.incomeCount === 0 && m.expenseCount === 0;
        return <span className={cn('font-medium', empty && 'text-muted-foreground')}>{MONTH_NAMES[m.monthNo - 1]}</span>;
      },
      className: 'w-[120px] whitespace-nowrap',
    },
    {
      key: 'income',
      header: 'Доход',
      align: 'right',
      cell: (m) => {
        const range = monthRange(m.year, m.monthNo);
        return (
          <Link
            href={`/transactions?from=${range.from}&to=${range.to}&type=INCOME` as Parameters<typeof Link>[0]['href']}
            className="hover:text-primary hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            <Money value={m.income} />
          </Link>
        );
      },
    },
    {
      key: 'expense',
      header: 'Расход',
      align: 'right',
      cell: (m) => {
        const range = monthRange(m.year, m.monthNo);
        return (
          <Link
            href={`/transactions?from=${range.from}&to=${range.to}&type=EXPENSE` as Parameters<typeof Link>[0]['href']}
            className="hover:text-primary hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            <Money value={m.expense} />
          </Link>
        );
      },
    },
    { key: 'base', header: 'База', align: 'right', cell: (m) => <Money value={m.base} /> },
    {
      key: 'taxCalc',
      header: 'Налог 20%',
      align: 'right',
      cell: (m) => <Money value={m.taxCalc} tone="plain" className="text-muted-foreground" />,
    },
    {
      key: 'taxMin',
      header: 'Мин. 3%',
      align: 'right',
      cell: (m) => <Money value={m.taxMin} tone="plain" className="text-muted-foreground" />,
    },
    { key: 'taxDue', header: 'К уплате', align: 'right', cell: (m) => <Money value={m.taxDue} className="font-semibold" /> },
    { key: 'taxPaid', header: 'Уплачено', align: 'right', cell: (m) => <Money value={m.taxPaid} /> },
    {
      key: 'dueDate',
      header: 'Срок',
      cell: (m) => <span className="whitespace-nowrap text-xs text-muted-foreground">{formatDate(m.dueDate)}</span>,
      className: 'w-[110px]',
    },
    {
      key: 'status',
      header: 'Статус',
      cell: (m) => <StatusDot tone={STATUS_META[m.status].tone} label={STATUS_META[m.status].label} />,
      className: 'w-[130px]',
    },
    {
      key: 'pay',
      header: '',
      align: 'right',
      hoverOnly: true,
      cell: (m) =>
        m.status === 'UNPAID' || m.status === 'PARTIAL' ? (
          <Button variant="ghost" size="sm" onClick={() => setPayFor(m)}>
            Уплатить
          </Button>
        ) : null,
      className: 'w-[110px]',
    },
  ];

  return (
    <>
      <PageHeader
        title="Налог"
        description={
          <>
            Налог рассчитывается автоматически по операциям: доход и расход по кассовому
            методу, 20% с базы (доходы−расходы), минимум 3% с доходов, срок уплаты — до 25-го
            следующего месяца. Маркировку операции (доход/расход/не учитывать) можно
            изменить в карточке операции.
          </>
        }
      />
      {/* Налог считается по годам — это его единица отчётности, а не произвольный
          период. Выглядеть выбор обязан как везде: FilterField + Select. */}
      <FilterBar>
        <FilterField label="Год">
          <Select
            value={String(year)}
            onChange={(e) => setYear(Number(e.target.value))}
            className="h-9 w-[150px]"
          >
            {YEARS.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </Select>
        </FilterField>
      </FilterBar>

      <div className="bg-card">
        <DataTable
          data={rep?.months ?? []}
          columns={columns}
          rowKey={(m) => m.month}
          loading={report.isLoading}
          error={report.error}
          onRetry={() => report.refetch()}
          empty={<EmptyState icon={Calculator} title="Нет данных" hint="Расчёт за этот год пуст." />}
          footer={
            rep
              ? {
                  month: 'Год',
                  income: <Money value={rep.totals.income} />,
                  expense: <Money value={rep.totals.expense} />,
                  taxDue: <Money value={rep.totals.taxDue} />,
                  taxPaid: <Money value={rep.totals.taxPaid} />,
                }
              : undefined
          }
          mobileCards={(m) => {
            const status = STATUS_META[m.status];
            return (
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{MONTH_NAMES[m.monthNo - 1]}</span>
                  <Money value={m.taxDue} className="font-semibold" />
                </div>
                <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>
                    доход <Money value={m.income} tone="plain" /> · расход <Money value={m.expense} tone="plain" />
                  </span>
                  <StatusDot tone={status.tone} label={status.label} />
                </div>
                {(m.status === 'UNPAID' || m.status === 'PARTIAL') && (
                  <Button variant="secondary" size="sm" onClick={() => setPayFor(m)}>
                    Уплатить
                  </Button>
                )}
              </div>
            );
          }}
        />
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
  const remaining = toMoneyString(sub(D(row.taxDue), D(row.taxPaid)));
  const [amount, setAmount] = useState(remaining);
  const [date, setDate] = useState(() => todayInput());

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
        date: fromLocalDateInput(date),
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
    <Modal open onOpenChange={(o) => !o && onClose()} dirty={amount !== remaining || !!accountId}>
      <ModalContent size="md" onConfirm={submit}>
        <ModalHeader>
          <ModalTitle>Уплата налога за {MONTH_NAMES[row.monthNo - 1]?.toLowerCase()} {row.year}</ModalTitle>
        </ModalHeader>
        <ModalBody className="space-y-3">
          <div className="rounded-md bg-secondary/40 p-3 text-sm">
            К уплате <b className="tabular-nums"><Money value={row.taxDue} /></b>
            {Number(row.taxPaid) > 0 && (
              <>
                {' · уже уплачено '}
                <Money value={row.taxPaid} tone="plain" />
              </>
            )}
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
            <FormField label="Дата уплаты" required>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </FormField>
          </div>
        </ModalBody>
        <ModalFooter>
          <ModalClose asChild><Button variant="secondary">Отмена</Button></ModalClose>
          <Button onClick={submit} disabled={!valid || pay.isPending}>
            <Check className="h-4 w-4" />
            {pay.isPending ? 'Сохранение…' : 'Отметить уплату'}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
