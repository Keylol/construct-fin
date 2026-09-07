'use client';

import { Suspense, useMemo } from 'react';
import Link from 'next/link';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { BarChart3, RotateCcw } from '@/components/ui/icons';
import { Money } from '@/components/ui/Money';
import { D, formatRub } from '@construct/shared';
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
import { useAccounts } from '@/hooks/useAccounts';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useCashflowReport } from '@/hooks/useReports';
import { useUrlFilters } from '@/hooks/useUrlFilters';
import { CHART_PALETTE as COLORS } from '@/lib/chart';
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

  const chartData = useMemo(() => {
    if (!query.data) return [];
    const labels = new Set<string>();
    for (const s of query.data.series) for (const p of s.points) labels.add(p.label);
    const sorted = Array.from(labels).sort();
    return sorted.map((label) => {
      const row: Record<string, string | number> = { label };
      for (const s of query.data!.series) {
        const point = s.points.find((p) => p.label === label);
        // Ключ ряда — accountId (одинаковые имена счетов не должны схлопываться);
        // подпись в легенде задаёт проп name у <Line>.
        row[s.accountId ?? 'none'] = point ? Number(point.balance) : 0;
      }
      return row;
    });
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

        {chartData.length > 0 && (
          <Card className="!p-3">
            <div className="h-80 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis
                    dataKey="label"
                    stroke="hsl(var(--muted-foreground))"
                    fontSize={12}
                  />
                  <YAxis
                    tickFormatter={(v) =>
                      new Intl.NumberFormat('ru-RU').format(Number(v))
                    }
                    stroke="hsl(var(--muted-foreground))"
                    fontSize={12}
                  />
                  <Tooltip
                    formatter={(v) => formatRub(Number(v))}
                    contentStyle={{
                      borderRadius: 6,
                      border: '1px solid hsl(var(--border))',
                      background: 'hsl(var(--card))',
                      fontSize: 12,
                    }}
                  />
                  <Legend verticalAlign="top" wrapperStyle={{ fontSize: 12 }} />
                  {query.data?.series.map((s, i) => (
                    <Line
                      key={s.accountId ?? i}
                      type="monotone"
                      dataKey={s.accountId ?? 'none'}
                      name={s.accountName ?? 'Без счёта'}
                      stroke={COLORS[i % COLORS.length]}
                      strokeWidth={2}
                      dot={false}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Card>
        )}

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
