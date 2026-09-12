'use client';

import { Suspense, useMemo } from 'react';
import Link from 'next/link';
import { BarChart3 } from '@/components/ui/icons';
import { Money } from '@/components/ui/Money';
import { D, add, toMoneyString } from '@construct/shared';
import { Card } from '@/components/ui/Card';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { FilterBar, FilterReset } from '@/components/ui/FilterBar';
import { FilterField } from '@/components/ui/FilterField';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { ExportButtons } from '@/components/reports/ExportButtons';
import { ReportPeriodFields } from '@/components/reports/ReportPeriodFields';
import { FlowChart, type FlowPoint } from '@/components/reports/FlowChart';
import { useAccounts } from '@/hooks/useAccounts';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useCashflowReport } from '@/hooks/useReports';
import { useUrlFilters } from '@/hooks/useUrlFilters';
import { reportCodec, reportPeriod, toPeriodParams } from '@/lib/report-filters';
import { txDrilldownHref } from '@/lib/tx-filters';
import type { CashflowPoint, CashflowSeries } from '@/lib/types';

type LinkHref = Parameters<typeof Link>[0]['href'];

const DEFAULT_PERIOD = 'this-year';
const EXTRAS = { accountId: '' };
const CODEC = reportCodec(DEFAULT_PERIOD, EXTRAS);

// useSearchParams требует Suspense-границу на уровне page (Next 14 App Router).
export default function CashflowReportPage() {
  return (
    <Suspense>
      <CashflowReportView />
    </Suspense>
  );
}

function CashflowReportView() {
  const { currentId: wsId } = useCurrentWorkspace();
  const [filters, setFilters] = useUrlFilters(CODEC);
  const accountId = filters.accountId || null;
  const periodParams = toPeriodParams(filters);

  const accounts = useAccounts(wsId);
  const query = useCashflowReport(wsId, periodParams, accountId);

  // Один график на все счета: приход и расход за период суммой, линия —
  // общий остаток (по выбранному счёту — его остаток). Суммы — Decimal.
  const points = useMemo<FlowPoint[]>(() => {
    if (!query.data) return [];
    const byLabel = new Map<string, { income: ReturnType<typeof D>; expense: ReturnType<typeof D>; line: ReturnType<typeof D> }>();
    for (const s of query.data.series) {
      for (const p of s.points) {
        const acc = byLabel.get(p.label) ?? { income: D(0), expense: D(0), line: D(0) };
        byLabel.set(p.label, {
          income: add(acc.income, p.inflow),
          expense: add(acc.expense, p.outflow),
          line: add(acc.line, p.balance),
        });
      }
    }
    return [...byLabel.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([label, v]) => ({
        label,
        income: toMoneyString(v.income),
        expense: toMoneyString(v.expense),
        line: toMoneyString(v.line),
      }));
  }, [query.data]);

  if (!wsId) return null;

  const pointColumns = (s: CashflowSeries): Column<CashflowPoint>[] => [
    {
      key: 'label',
      header: 'Период',
      cell: (p) =>
        s.accountId !== null ? (
          <Link
            href={txDrilldownHref({ accountId: s.accountId, from: p.from, to: p.to }) as LinkHref}
            className="hover:text-foreground hover:underline"
          >
            {p.label}
          </Link>
        ) : (
          p.label
        ),
    },
    {
      key: 'inflow',
      header: 'Поступления',
      align: 'right',
      cell: (p) => <Money value={p.inflow} tone="plain" className="text-success" />,
    },
    {
      key: 'outflow',
      header: 'Выплаты',
      align: 'right',
      cell: (p) => <Money value={p.outflow} tone="plain" className="text-destructive" />,
    },
    {
      key: 'balance',
      header: 'Остаток',
      align: 'right',
      cell: (p) => (
        <span title={D(p.balance).lt(0) ? 'Отрицательный остаток (кассовый разрыв)' : undefined}>
          <Money value={p.balance} className="font-medium" />
        </span>
      ),
    },
  ];
  const pointCard = (p: CashflowPoint) => (
    <div className="flex items-baseline justify-between gap-3">
      <div>
        <div className="font-medium">{p.label}</div>
        <div className="text-xs text-muted-foreground">
          +<Money value={p.inflow} tone="plain" /> · −<Money value={p.outflow} tone="plain" />
        </div>
      </div>
      <Money value={p.balance} className="font-semibold" />
    </div>
  );

  return (
    <>
      <FilterBar>
        <ReportPeriodFields value={filters} onChange={(p) => setFilters({ ...filters, ...p })} />
        <FilterField label="Счёт">
          <Select
            value={filters.accountId}
            onChange={(e) => setFilters({ ...filters, accountId: e.target.value })}
            className="h-9 w-[180px]"
          >
            <option value="">Все счета</option>
            {accounts.data?.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </FilterField>
        <FilterReset onClick={() => setFilters({ ...reportPeriod(DEFAULT_PERIOD), ...EXTRAS })} />
        <div className="ml-auto self-end">
          <ExportButtons
            wsId={wsId}
            kind="cashflow"
            params={{ ...periodParams, accountId: accountId ?? undefined }}
          />
        </div>
      </FilterBar>

      <div className="space-y-4 px-6 py-4">
        {query.isLoading && <Skeleton className="h-80 w-full" />}
        {query.isError && (
          <ErrorState error={query.error} onRetry={() => query.refetch()} />
        )}

        {query.data &&
          (query.data.series.length === 0 ||
            query.data.series.every((s) => s.points.length === 0)) && (
            <Card>
              <EmptyState
                icon={BarChart3}
                title="Нет движений за период"
                hint="Поменяйте период или добавьте операции."
              />
            </Card>
          )}

        <FlowChart
          points={points}
          title="Движение денег"
          caption={accountId ? 'по выбранному счёту' : 'по всем счетам'}
          incomeLabel="Поступления"
          expenseLabel="Выплаты"
          lineLabel="Остаток на конец периода"
        />

        {query.data && (
          <div className="grid gap-3 md:grid-cols-2">
            {query.data.series.map((s) => (
              <Card key={s.accountId ?? 'none'} className="overflow-hidden !p-0">
                <header className="flex items-baseline justify-between border-b border-border px-4 py-3">
                  <h3 className="font-medium">{s.accountName ?? 'Без счёта'}</h3>
                  <span className="text-xs text-muted-foreground">
                    Остаток на начало: <Money value={s.openingBalance} />
                  </span>
                </header>
                <DataTable
                  data={s.points}
                  columns={pointColumns(s)}
                  rowKey={(p) => p.label}
                  mobileCards={pointCard}
                  empty={<p className="px-4 text-sm text-muted-foreground">Нет движений за период.</p>}
                />
              </Card>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
