'use client';

import { Suspense } from 'react';
import Link from 'next/link';
import { BarChart3 } from '@/components/ui/icons';
import { Money } from '@/components/ui/Money';
import { D, add, toMoneyString, sub } from '@construct/shared';
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
import { ShareDonut } from '@/components/reports/ShareDonut';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useBreakdownReport } from '@/hooks/useReports';
import { useUrlFilters } from '@/hooks/useUrlFilters';
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
  const sum = (pick: (r: BreakdownRow) => string) =>
    toMoneyString(rows.reduce((acc, r) => add(acc, pick(r)), D(0)));
  const total = sum((r) => r.total);
  // При типе «Всё» сервер отдаёт в total оборот (доход + расход) — такое число
  // ничего не значит, а «Итого» внизу складывало приход с расходом. В этом режиме
  // показываем доход, расход и сальдо по статье, без долей и кольца (аудит 27.09).
  const all = type === 'ALL';
  const net = (r: BreakdownRow) => toMoneyString(sub(D(r.income), D(r.expense)));

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

  // Кольцо долей над таблицей (20.09): решение 10.09 «графики только в ОПиУ и
  // ОДДС» отменено владельцем именно для этого разреза — он отвечает на вопрос
  // «куда уходят деньги», а тридцать строк с процентами глазом не складываются.
  // Таблица остаётся источником точных сумм, колонка «Доля» — тоже.
  const columns: Column<BreakdownRow>[] = all
    ? [
        { key: 'name', header: 'Категория', cell: name, className: 'w-full max-w-0' },
        { key: 'count', header: 'Операций', align: 'right', cell: (r) => r.count, className: 'w-[110px]' },
        {
          key: 'income',
          header: 'Доход',
          align: 'right',
          cell: (r) => <Money value={r.income} tone="plain" className="text-success" />,
          className: 'w-[150px]',
        },
        {
          key: 'expense',
          header: 'Расход',
          align: 'right',
          cell: (r) => <Money value={r.expense} tone="plain" className="text-destructive" />,
          className: 'w-[150px]',
        },
        {
          key: 'total',
          header: 'Сальдо',
          align: 'right',
          cell: (r) => <Money value={net(r)} className="font-medium" />,
          className: 'w-[150px]',
        },
      ]
    : [
        { key: 'name', header: 'Категория', cell: name, className: 'w-full max-w-0' },
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
        <div className="truncate font-medium">{name(r)}</div>
        <div className="text-xs text-muted-foreground">
          {all ? (
            <>
              {r.count} оп. · +<Money value={r.income} tone="plain" /> · −
              <Money value={r.expense} tone="plain" />
            </>
          ) : (
            <>
              {r.count} оп. · {(r.share * 100).toFixed(1)}%
            </>
          )}
        </div>
      </div>
      <Money value={all ? net(r) : r.total} className="font-semibold" />
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
        <FilterReset onClick={() => setFilters({ ...reportPeriod(DEFAULT_PERIOD), ...EXTRAS })} />
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

        {query.data && rows.length > 0 && !all && (
          <ShareDonut
            points={rows}
            title={type === 'INCOME' ? 'Структура доходов' : 'Структура расходов'}
          />
        )}

        {query.data && rows.length > 0 && (
          <Card className="overflow-hidden !p-0">
            <DataTable
              data={rows}
              columns={columns}
              rowKey={(r) => r.id ?? `none:${r.name}`}
              mobileCards={card}
              footer={
                all
                  ? {
                      name: 'Итого',
                      income: <Money value={sum((r) => r.income)} />,
                      expense: <Money value={sum((r) => r.expense)} />,
                      total: <Money value={sum(net)} />,
                    }
                  : { name: 'Итого', total: <Money value={total} /> }
              }
            />
          </Card>
        )}
      </div>
    </>
  );
}
