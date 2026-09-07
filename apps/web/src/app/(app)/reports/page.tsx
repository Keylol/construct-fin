'use client';

import { Suspense } from 'react';
import Link from 'next/link';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { BarChart3, RotateCcw } from '@/components/ui/icons';
import { Money } from '@/components/ui/Money';
import { D, formatRub, sub, toMoneyString } from '@construct/shared';
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
import { ExportButtons } from '@/components/reports/ExportButtons';
import { PnlWaterfall } from '@/components/reports/PnlWaterfall';
import { ReportPeriodFields } from '@/components/reports/ReportPeriodFields';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { usePnlReport } from '@/hooks/useReports';
import { useUrlFilters } from '@/hooks/useUrlFilters';
import { BUCKET_LABEL } from '@/lib/buckets';
import { CHART_SEMANTIC } from '@/lib/chart';
import { cn } from '@/lib/cn';
import { reportCodec, reportPeriod, toPeriodParams } from '@/lib/report-filters';
import { txDrilldownHref } from '@/lib/tx-filters';
import type { BucketBreakdown, CompareMode, PnlBucket } from '@/lib/types';

type LinkHref = Parameters<typeof Link>[0]['href'];

const CHART_COLORS = {
  income: CHART_SEMANTIC.income,
  expense: CHART_SEMANTIC.expense,
  incomeCmp: CHART_SEMANTIC.incomeMuted,
  expenseCmp: CHART_SEMANTIC.expenseMuted,
};

const DEFAULT_PERIOD = 'this-year';
const EXTRAS = { groupBy: 'month', compare: 'none' };
const CODEC = reportCodec(DEFAULT_PERIOD, EXTRAS);

// useSearchParams требует Suspense-границу на уровне page (Next 14 App Router).
export default function PnlReportPage() {
  return (
    <Suspense>
      <PnlReportView />
    </Suspense>
  );
}

function PnlReportView() {
  const { currentId: wsId } = useCurrentWorkspace();
  // Период, группировка и сравнение живут в адресе — F5 и ссылка коллеге
  // открывают тот же разрез. Мусор из адреса — в умолчание.
  const [filters, setFilters] = useUrlFilters(CODEC);
  const groupBy = filters.groupBy === 'quarter' ? 'quarter' : 'month';
  const compareWith: CompareMode =
    filters.compare === 'prev' || filters.compare === 'yoy' ? filters.compare : 'none';
  const periodParams = toPeriodParams(filters);

  const query = usePnlReport(wsId, periodParams, groupBy, compareWith);

  if (!wsId) return null;

  // Для recharts — числа; деньги в таблицах и плитках остаются строками.
  const data =
    query.data?.primary.buckets.map((b, i) => ({
      label: b.label,
      Доходы: Number(b.income),
      Расходы: -Number(b.expense),
      cmpDoxod: query.data?.comparison
        ? Number(query.data.comparison.buckets[i]?.income ?? 0)
        : undefined,
      cmpRashod: query.data?.comparison
        ? -Number(query.data.comparison.buckets[i]?.expense ?? 0)
        : undefined,
    })) ?? [];

  const totals = query.data?.primary.totals;
  // Отчёт загружен, но пуст: все итоги нулевые и в разбивке по группам нет
  // ни одной строки с суммами — вместо голых нулей показываем EmptyState.
  const reportEmpty =
    !!totals &&
    D(totals.income).isZero() &&
    D(totals.expense).isZero() &&
    totals.byBucket.every((b) => D(b.income).isZero() && D(b.expense).isZero());

  const groups =
    totals?.byBucket.filter((b) => !D(b.income).isZero() || !D(b.expense).isZero()) ?? [];
  const groupNet = (b: BucketBreakdown) => toMoneyString(sub(b.income, b.expense));
  // IJ9 (решение №4): выручка/себестоимость признаются по реализации —
  // drill-down ведёт в ЗАКАЗЫ, закрытые в периоде (сумма сходится с цифрой
  // отчёта). Прочие группы — операции с bucket-фильтром.
  const groupHref = (b: BucketBreakdown) =>
    b.bucket === 'REVENUE' || b.bucket === 'COGS'
      ? `/orders?status=DONE&closedFrom=${encodeURIComponent(totals?.from ?? '')}&closedTo=${encodeURIComponent(totals?.to ?? '')}`
      : txDrilldownHref({ bucket: b.bucket, from: totals?.from, to: totals?.to });

  const groupColumns: Column<BucketBreakdown>[] = [
    {
      key: 'bucket',
      header: 'Группа',
      cell: (b) => (
        <>
          <Link href={groupHref(b) as LinkHref} className="hover:text-foreground hover:underline">
            {BUCKET_LABEL[b.bucket]}
          </Link>
          {(b.bucket === 'CAPITAL' || b.bucket === 'PURCHASES') && (
            <span className="ml-2 text-xs text-muted-foreground">(не входит в чистую прибыль)</span>
          )}
        </>
      ),
    },
    {
      key: 'income',
      header: 'Доходы',
      align: 'right',
      cell: (b) =>
        D(b.income).isZero() ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <Money value={b.income} tone="plain" className="text-success" />
        ),
    },
    {
      key: 'expense',
      header: 'Расходы',
      align: 'right',
      cell: (b) =>
        D(b.expense).isZero() ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <Money value={b.expense} tone="plain" className="text-destructive" />
        ),
    },
    {
      key: 'net',
      header: 'Сальдо',
      align: 'right',
      cell: (b) => {
        const net = groupNet(b);
        return <Money value={net} className={cn('font-medium', D(net).gte(0) && 'text-success')} />;
      },
    },
  ];
  const groupCard = (b: BucketBreakdown) => (
    <div className="flex items-baseline justify-between gap-3">
      <div>
        <Link href={groupHref(b) as LinkHref} className="font-medium">
          {BUCKET_LABEL[b.bucket]}
        </Link>
        <div className="text-xs text-muted-foreground">
          доход <Money value={b.income} tone="plain" /> · расход{' '}
          <Money value={b.expense} tone="plain" />
        </div>
      </div>
      <Money value={groupNet(b)} className="font-semibold" />
    </div>
  );

  const periodColumns: Column<PnlBucket>[] = [
    {
      key: 'label',
      header: 'Период',
      cell: (b) => (
        <Link
          href={txDrilldownHref({ from: b.from, to: b.to }) as LinkHref}
          className="hover:text-foreground hover:underline"
        >
          {b.label}
        </Link>
      ),
    },
    {
      key: 'income',
      header: 'Доходы',
      align: 'right',
      cell: (b) => <Money value={b.income} tone="plain" className="text-success" />,
    },
    {
      key: 'expense',
      header: 'Расходы',
      align: 'right',
      cell: (b) => <Money value={b.expense} tone="plain" className="text-destructive" />,
    },
    {
      key: 'net',
      header: 'Чистая прибыль',
      align: 'right',
      cell: (b) => (
        <Money value={b.net} className={cn('font-medium', D(b.net).gte(0) && 'text-success')} />
      ),
    },
  ];
  const periodCard = (b: PnlBucket) => (
    <div className="flex items-baseline justify-between gap-3">
      <div>
        <div className="font-medium">{b.label}</div>
        <div className="text-xs text-muted-foreground">
          доход <Money value={b.income} tone="plain" /> · расход{' '}
          <Money value={b.expense} tone="plain" />
        </div>
      </div>
      <Money value={b.net} className="font-semibold" />
    </div>
  );

  return (
    <>
      <FilterBar>
        <ReportPeriodFields value={filters} onChange={(p) => setFilters({ ...filters, ...p })} />
        <FilterField label="Группировка">
          <Select
            value={groupBy}
            onChange={(e) => setFilters({ ...filters, groupBy: e.target.value })}
            className="h-9 w-[120px]"
          >
            <option value="month">Месяц</option>
            <option value="quarter">Квартал</option>
          </Select>
        </FilterField>
        <FilterField label="Сравнить">
          <Select
            value={compareWith}
            onChange={(e) => setFilters({ ...filters, compare: e.target.value })}
            className="h-9 w-[160px]"
          >
            <option value="none">—</option>
            <option value="prev">Пред. период</option>
            <option value="yoy">Год к году</option>
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
          <ExportButtons wsId={wsId} kind="pnl" params={{ ...periodParams, groupBy }} />
        </div>
      </FilterBar>

      <div className="space-y-4 px-6 py-4">
        {query.isError ? (
          <ErrorState error={query.error} onRetry={() => query.refetch()} />
        ) : (
          <>
            {/* IJ11: на P&L показываем ОПЕРАЦИОННЫЕ доход/расход (без капитала
                собственника и неденежных списаний) — иначе одинаковый ярлык
                «Расходы» с дашбордом (кэш-поток) давал разные суммы за период. */}
            <KpiRow loading={query.isLoading} count={3} className="stagger">
              {totals && (
                <>
                  <KpiCard label="Операционные доходы" value={<Money value={totals.income} />} tone="positive" />
                  <KpiCard label="Операционные расходы" value={<Money value={totals.expense} />} tone="negative" />
                  <KpiCard
                    label="Чистая прибыль"
                    value={<Money value={totals.net} />}
                    tone={D(totals.net).gte(0) ? 'positive' : 'negative'}
                  />
                </>
              )}
            </KpiRow>
            {totals && D(totals.cogs).gt(0) && (
              <KpiRow count={2}>
                <KpiCard label="Себестоимость продаж" value={<Money value={totals.cogs} />} tone="negative" />
                <KpiCard
                  label="Валовая прибыль (Выручка − Себестоимость)"
                  value={<Money value={totals.grossProfit} />}
                  tone={D(totals.grossProfit).gte(0) ? 'positive' : 'negative'}
                />
              </KpiRow>
            )}
          </>
        )}

        {reportEmpty && (
          <Card>
            <EmptyState
              icon={BarChart3}
              title="Нет операций за период"
              hint="Поменяйте период или добавьте операции."
            />
          </Card>
        )}

        {/* Водопад: из чего сложилась чистая прибыль периода. */}
        {!reportEmpty && totals && <PnlWaterfall totals={totals} />}

        {!reportEmpty && data.length > 0 && (
          <Card className="!p-3">
            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
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
                    formatter={(v) => formatRub(Math.abs(Number(v)))}
                    contentStyle={{
                      borderRadius: 6,
                      border: '1px solid hsl(var(--border))',
                      background: 'hsl(var(--card))',
                      fontSize: 12,
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="Доходы" fill={CHART_COLORS.income} radius={[2, 2, 0, 0]} />
                  <Bar dataKey="Расходы" fill={CHART_COLORS.expense} radius={[2, 2, 0, 0]} />
                  {compareWith !== 'none' && (
                    <>
                      <Bar
                        dataKey="cmpDoxod"
                        name="Доходы (сравн.)"
                        fill={CHART_COLORS.incomeCmp}
                        radius={[2, 2, 0, 0]}
                      />
                      <Bar
                        dataKey="cmpRashod"
                        name="Расходы (сравн.)"
                        fill={CHART_COLORS.expenseCmp}
                        radius={[2, 2, 0, 0]}
                      />
                    </>
                  )}
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>
        )}

        {!reportEmpty && totals && groups.length > 0 && (
          <Card className="overflow-hidden !p-0">
            <div className="flex items-baseline justify-between border-b border-border px-4 py-2">
              <span className="text-sm font-medium">По группам</span>
              {/* IJ9: базис отчёта — по реализации (деньги — в ОДДС) */}
              <span className="text-xs text-muted-foreground">
                выручка и себестоимость — по дате закрытия заказа
              </span>
            </div>
            <DataTable
              data={groups}
              columns={groupColumns}
              rowKey={(b) => b.bucket}
              mobileCards={groupCard}
            />
          </Card>
        )}

        {!reportEmpty && query.data && query.data.primary.buckets.length > 0 && (
          <Card className="overflow-hidden !p-0">
            <DataTable
              data={query.data.primary.buckets}
              columns={periodColumns}
              rowKey={(b) => b.label}
              mobileCards={periodCard}
              footer={
                totals && {
                  label: 'Итого',
                  income: <Money value={totals.income} />,
                  expense: <Money value={totals.expense} />,
                  net: <Money value={totals.net} />,
                }
              }
            />
          </Card>
        )}
      </div>
    </>
  );
}
