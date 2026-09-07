'use client';

import { Suspense } from 'react';
import Link from 'next/link';
import { BarChart3, RotateCcw } from '@/components/ui/icons';
import { Money } from '@/components/ui/Money';
import { D } from '@construct/shared';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { FilterBar } from '@/components/ui/FilterBar';
import { FilterField } from '@/components/ui/FilterField';
import { KpiCard } from '@/components/ui/KpiCard';
import { KpiRow } from '@/components/ui/KpiRow';
import { Select } from '@/components/ui/Select';
import { MarginTopBar } from '@/components/reports/MarginTopBar';
import { ReportPeriodFields } from '@/components/reports/ReportPeriodFields';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useMarginReport } from '@/hooks/useTradeReports';
import { useUrlFilters } from '@/hooks/useUrlFilters';
import { cn } from '@/lib/cn';
import { reportCodec, reportPeriod, toPeriodParams } from '@/lib/report-filters';
import type { MarginRow } from '@/lib/types';

type LinkHref = Parameters<typeof Link>[0]['href'];
type Method = 'by-product' | 'by-client';
type Row = MarginRow & { rowId: string };

const DEFAULT_PERIOD = 'this-year';
const EXTRAS = { method: 'by-product' };
const CODEC = reportCodec(DEFAULT_PERIOD, EXTRAS);

// useSearchParams требует Suspense-границу на уровне page (Next 14 App Router).
export default function MarginReportPage() {
  return (
    <Suspense>
      <MarginReportView />
    </Suspense>
  );
}

function MarginReportView() {
  const { currentId: wsId } = useCurrentWorkspace();
  const [filters, setFilters] = useUrlFilters(CODEC);
  const method: Method = filters.method === 'by-client' ? 'by-client' : 'by-product';
  const periodParams = toPeriodParams(filters);

  const query = useMarginReport(method, wsId, periodParams);

  if (!wsId) return null;

  const totals = query.data?.totals;
  const isProduct = method === 'by-product';
  // Ключ строки: by-client — id клиента; by-product — имя (с индексом на случай дублей).
  const rows: Row[] = (query.data?.rows ?? []).map((r, i) => ({
    ...r,
    rowId: r.key ?? `${r.name}-${i}`,
  }));

  const name = (r: MarginRow) =>
    // By-client: ключ = id клиента → ярлык-drill-down в карточку.
    !isProduct && r.key ? (
      <Link href={`/clients/${r.key}` as LinkHref} className="hover:text-primary hover:underline">
        {r.name}
      </Link>
    ) : (
      r.name
    );

  const columns: Column<Row>[] = [
    { key: 'name', header: isProduct ? 'Товар' : 'Клиент', cell: name },
    ...(isProduct
      ? [
          {
            key: 'qty',
            header: 'Кол-во',
            align: 'right' as const,
            cell: (r: Row) => <span className="text-muted-foreground">{r.qty}</span>,
          },
        ]
      : []),
    {
      key: 'revenue',
      header: 'Выручка',
      align: 'right',
      cell: (r) => <Money value={r.revenue} tone="plain" className="text-success" />,
    },
    {
      key: 'cogs',
      header: 'Себестоимость',
      align: 'right',
      cell: (r) => <Money value={r.cogs} tone="plain" className="text-destructive" />,
    },
    {
      key: 'margin',
      header: 'Валовая прибыль',
      align: 'right',
      cell: (r) => (
        <Money value={r.margin} className={cn('font-medium', D(r.margin).gte(0) && 'text-success')} />
      ),
    },
    {
      key: 'marginPct',
      header: 'Рентабельность, %',
      align: 'right',
      cell: (r) => <span className="text-muted-foreground">{r.marginPct}%</span>,
    },
  ];
  const card = (r: Row) => (
    <div className="flex items-baseline justify-between gap-3">
      <div className="min-w-0">
        <div className="truncate font-medium">{name(r)}</div>
        <div className="text-xs text-muted-foreground">
          {isProduct && `${r.qty} шт. · `}выручка <Money value={r.revenue} tone="plain" /> ·{' '}
          {r.marginPct}%
        </div>
      </div>
      <Money value={r.margin} className="font-semibold" />
    </div>
  );

  return (
    <>
      <FilterBar>
        <ReportPeriodFields value={filters} onChange={(p) => setFilters({ ...filters, ...p })} />
        <FilterField label="Разрез">
          <Select
            value={method}
            onChange={(e) => setFilters({ ...filters, method: e.target.value })}
            className="h-9 w-[160px]"
          >
            <option value="by-product">По товарам</option>
            <option value="by-client">По клиентам</option>
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
      </FilterBar>

      <div className="space-y-4 px-6 py-4">
        {query.isError ? (
          <ErrorState error={query.error} onRetry={() => query.refetch()} />
        ) : (
          <KpiRow loading={query.isLoading} count={4} className="stagger">
            {totals && (
              <>
                <KpiCard label="Выручка" value={<Money value={totals.revenue} />} tone="positive" />
                <KpiCard label="Себестоимость" value={<Money value={totals.cogs} />} tone="negative" />
                <KpiCard
                  label="Валовая прибыль"
                  value={<Money value={totals.margin} />}
                  tone={D(totals.margin).gte(0) ? 'positive' : 'negative'}
                />
                <KpiCard label="Рентабельность, %" value={`${totals.marginPct}%`} />
              </>
            )}
          </KpiRow>
        )}

        {/* Топ-10 по валовой прибыли: что реально кормит бизнес. */}
        {rows.length > 0 && (
          <MarginTopBar
            rows={rows}
            title={isProduct ? 'Топ товаров по валовой прибыли' : 'Топ клиентов по валовой прибыли'}
          />
        )}

        {query.data && (
          <Card className="overflow-hidden !p-0">
            <DataTable
              data={rows}
              columns={columns}
              rowKey={(r) => r.rowId}
              mobileCards={card}
              empty={
                <EmptyState
                  icon={BarChart3}
                  title="Нет закрытых заказов за период"
                  hint="Валовая прибыль считается по дате закрытия заказа — поменяйте период."
                />
              }
              footer={
                totals && rows.length > 0
                  ? {
                      name: 'Итого',
                      revenue: <Money value={totals.revenue} />,
                      cogs: <Money value={totals.cogs} />,
                      margin: <Money value={totals.margin} />,
                      marginPct: `${totals.marginPct}%`,
                    }
                  : undefined
              }
            />
          </Card>
        )}
      </div>
    </>
  );
}
