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
import { CategoryDonut, donutKey, donutSlices } from '@/components/reports/CategoryDonut';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useBreakdownReport } from '@/hooks/useReports';
import { useUrlFilters } from '@/hooks/useUrlFilters';
import { CHART_OTHER } from '@/lib/chart';
import { reportCodec, reportPeriod, toPeriodParams } from '@/lib/report-filters';
import { txDrilldownHref } from '@/lib/tx-filters';
import type { BreakdownRow } from '@/lib/types';

type LinkHref = Parameters<typeof Link>[0]['href'];
type BreakdownType = 'INCOME' | 'EXPENSE' | 'ALL';

const DEFAULT_PERIOD = 'this-month';
const EXTRAS = { type: 'EXPENSE' };
const CODEC = reportCodec(DEFAULT_PERIOD, EXTRAS);

// useSearchParams требует Suspense-границу на уровне page (Next 14 App Router).
export default function CategoriesReportPage() {
  return (
    <Suspense>
      <CategoriesReportView />
    </Suspense>
  );
}

function CategoriesReportView() {
  const { currentId: wsId } = useCurrentWorkspace();
  const [filters, setFilters] = useUrlFilters(CODEC);
  const type: BreakdownType =
    filters.type === 'INCOME' || filters.type === 'ALL' ? filters.type : 'EXPENSE';
  const periodParams = toPeriodParams(filters);

  const query = useBreakdownReport('by-category', wsId, periodParams, type);

  if (!wsId) return null;

  const rows = query.data?.rows ?? [];
  const period = query.data?.period;
  // Цвет сектора ↔ маркер строки: один источник (donutSlices, фиксированный порядок).
  const sliceColorByKey = new Map(donutSlices(rows).map((s) => [s.key, s.color]));
  const total = toMoneyString(rows.reduce((acc, r) => add(acc, r.total), D(0)));

  const marker = (r: BreakdownRow) => (
    <span
      className="mr-2 inline-block h-2.5 w-2.5 translate-y-px rounded-[3px]"
      style={{
        // Мелкие категории свёрнуты в сектор «Прочее» — тот же серый.
        background: sliceColorByKey.get(donutKey(r)) ?? CHART_OTHER,
      }}
      aria-hidden
    />
  );
  const name = (r: BreakdownRow) =>
    r.id !== null ? (
      <Link
        href={
          txDrilldownHref({
            categoryId: r.id,
            from: period?.from,
            to: period?.to,
            type: type === 'ALL' ? undefined : type,
          }) as LinkHref
        }
        className="hover:underline"
      >
        {r.name}
      </Link>
    ) : (
      r.name
    );

  // Доля — полосой прямо в строке (дублирует donut числами: мелкие категории
  // читаются, а цветной маркер связывает строку с сектором).
  const columns: Column<BreakdownRow>[] = [
    {
      key: 'name',
      header: 'Категория',
      cell: (r) => (
        <div>
          {marker(r)}
          {name(r)}
          <div className="mt-1.5 h-1 w-full max-w-[360px] overflow-hidden rounded-full bg-border/50">
            <div
              className="h-full rounded-full bg-primary/70"
              // Доля честная (от 100%); минимум 1% — чтобы мелкие были видны.
              style={{ width: `${Math.max(r.share * 100, 1)}%` }}
            />
          </div>
        </div>
      ),
    },
    { key: 'count', header: 'Операций', align: 'right', cell: (r) => r.count, className: 'w-[110px]' },
    {
      key: 'total',
      header: 'Итого',
      align: 'right',
      cell: (r) => <Money value={r.total} className="font-medium" />,
      className: 'w-[170px]',
    },
    {
      key: 'share',
      header: 'Доля',
      align: 'right',
      cell: (r) => <span className="text-muted-foreground">{(r.share * 100).toFixed(1)}%</span>,
      className: 'w-[90px]',
    },
  ];
  const card = (r: BreakdownRow) => (
    <div className="flex items-baseline justify-between gap-3">
      <div className="min-w-0">
        <div className="truncate font-medium">
          {marker(r)}
          {name(r)}
        </div>
        <div className="text-xs text-muted-foreground">
          {r.count} оп. · {(r.share * 100).toFixed(1)}%
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
            <option value="EXPENSE">Расход</option>
            <option value="INCOME">Доход</option>
            <option value="ALL">Всё</option>
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
          <ExportButtons wsId={wsId} kind="by-category" params={{ ...periodParams, type }} />
        </div>
      </FilterBar>

      <div className="space-y-4 px-6 py-4">
        {query.isLoading && <Skeleton className="h-80 w-full" />}
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

        {/* Структура периода: donut топ-7 + «Прочее», легенда с суммами. */}
        {query.data && rows.length > 0 && (
          <CategoryDonut
            rows={rows}
            title={
              type === 'INCOME'
                ? 'Структура доходов'
                : type === 'EXPENSE'
                  ? 'Структура расходов'
                  : 'Структура оборота'
            }
            totalLabel={type === 'INCOME' ? 'Доходы' : type === 'EXPENSE' ? 'Расходы' : 'Оборот'}
          />
        )}

        {query.data && rows.length > 0 && (
          <Card className="overflow-hidden !p-0">
            <DataTable
              data={rows}
              columns={columns}
              rowKey={donutKey}
              mobileCards={card}
              footer={{ name: 'Итого', total: <Money value={total} /> }}
            />
          </Card>
        )}
      </div>
    </>
  );
}
