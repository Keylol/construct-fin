'use client';

import { Suspense } from 'react';
import Link from 'next/link';
import { BarChart3, RotateCcw } from '@/components/ui/icons';
import { Money } from '@/components/ui/Money';
import { D, add, toMoneyString } from '@construct/shared';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { FilterBar } from '@/components/ui/FilterBar';
import { FilterField } from '@/components/ui/FilterField';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { ExportButtons } from '@/components/reports/ExportButtons';
import { ReportPeriodFields } from '@/components/reports/ReportPeriodFields';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useBreakdownReport } from '@/hooks/useReports';
import { useUrlFilters } from '@/hooks/useUrlFilters';
import { reportCodec, reportPeriod, toPeriodParams } from '@/lib/report-filters';
import { txDrilldownHref } from '@/lib/tx-filters';
import type { BreakdownRow } from '@/lib/types';

type LinkHref = Parameters<typeof Link>[0]['href'];
type BreakdownType = 'INCOME' | 'EXPENSE' | 'ALL';

const DEFAULT_PERIOD = 'this-month';
const EXTRAS = { type: 'ALL' };
const CODEC = reportCodec(DEFAULT_PERIOD, EXTRAS);

// useSearchParams требует Suspense-границу на уровне page (Next 14 App Router).
export default function CounterpartiesReportPage() {
  return (
    <Suspense>
      <CounterpartiesReportView />
    </Suspense>
  );
}

function CounterpartiesReportView() {
  const { currentId: wsId } = useCurrentWorkspace();
  const [filters, setFilters] = useUrlFilters(CODEC);
  const type: BreakdownType =
    filters.type === 'INCOME' || filters.type === 'EXPENSE' ? filters.type : 'ALL';
  const periodParams = toPeriodParams(filters);

  const query = useBreakdownReport('by-counterparty', wsId, periodParams, type);

  if (!wsId) return null;

  const rows = query.data?.rows ?? [];
  const period = query.data?.period;
  const sum = (pick: (r: BreakdownRow) => string) =>
    toMoneyString(rows.reduce((acc, r) => add(acc, pick(r)), D(0)));

  const name = (r: BreakdownRow) =>
    r.id !== null ? (
      <Link
        href={
          txDrilldownHref({
            counterpartyId: r.id,
            from: period?.from,
            to: period?.to,
            type: type === 'ALL' ? undefined : type,
          }) as LinkHref
        }
        className="hover:text-foreground hover:underline"
      >
        {r.name}
      </Link>
    ) : (
      r.name
    );

  const columns: Column<BreakdownRow>[] = [
    { key: 'name', header: 'Контрагент', cell: name },
    { key: 'count', header: 'Операций', align: 'right', cell: (r) => r.count, className: 'w-[110px]' },
    {
      key: 'income',
      header: 'Доход',
      align: 'right',
      cell: (r) => <Money value={r.income} tone="plain" className="text-success" />,
    },
    {
      key: 'expense',
      header: 'Расход',
      align: 'right',
      cell: (r) => <Money value={r.expense} tone="plain" className="text-destructive" />,
    },
    {
      key: 'total',
      header: 'Итого',
      align: 'right',
      cell: (r) => <Money value={r.total} className="font-medium" />,
    },
  ];
  const card = (r: BreakdownRow) => (
    <div className="flex items-baseline justify-between gap-3">
      <div className="min-w-0">
        <div className="truncate font-medium">{name(r)}</div>
        <div className="text-xs text-muted-foreground">
          {r.count} оп. · +<Money value={r.income} tone="plain" /> · −
          <Money value={r.expense} tone="plain" />
        </div>
      </div>
      <Money value={r.total} className="font-semibold" />
    </div>
  );

  return (
    <>
      <FilterBar>
        <ReportPeriodFields value={filters} onChange={(p) => setFilters({ ...filters, ...p })} />
        <FilterField label="Тип">
          <Select
            value={type}
            onChange={(e) => setFilters({ ...filters, type: e.target.value })}
            className="h-9 w-[120px]"
          >
            <option value="ALL">Всё</option>
            <option value="EXPENSE">Расход</option>
            <option value="INCOME">Доход</option>
          </Select>
        </FilterField>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setFilters({ ...reportPeriod(DEFAULT_PERIOD), ...EXTRAS })}
          className="self-end"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Сброс
        </Button>
        <div className="ml-auto self-end">
          <ExportButtons wsId={wsId} kind="by-counterparty" params={{ ...periodParams, type }} />
        </div>
      </FilterBar>

      <div className="space-y-4 px-6 py-4">
        {query.isLoading && <Skeleton className="h-64 w-full" />}
        {query.isError && (
          <ErrorState error={query.error} onRetry={() => query.refetch()} />
        )}

        {query.data && rows.length === 0 && (
          <Card>
            <EmptyState
              icon={BarChart3}
              title="Нет операций за период"
              hint="Поменяйте период или тип — либо добавьте операции."
            />
          </Card>
        )}

        {query.data && rows.length > 0 && (
          <Card className="overflow-hidden !p-0">
            <DataTable
              data={rows}
              columns={columns}
              rowKey={(r) => r.id ?? `none:${r.name}`}
              mobileCards={card}
              footer={{
                name: 'Итого',
                income: <Money value={sum((r) => r.income)} />,
                expense: <Money value={sum((r) => r.expense)} />,
                total: <Money value={sum((r) => r.total)} />,
              }}
            />
          </Card>
        )}
      </div>
    </>
  );
}
