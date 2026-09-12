'use client';

import { Suspense } from 'react';
import Link from 'next/link';
import { BarChart3 } from '@/components/ui/icons';
import { Money } from '@/components/ui/Money';
import { D, formatRub, sub, toMoneyString } from '@construct/shared';
import { Card } from '@/components/ui/Card';
import { SectionCard } from '@/components/ui/SectionCard';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { FilterBar, FilterReset } from '@/components/ui/FilterBar';
import { FilterField } from '@/components/ui/FilterField';
import { KpiCard } from '@/components/ui/KpiCard';
import { KpiRow } from '@/components/ui/KpiRow';
import { Select } from '@/components/ui/Select';
import { ExportButtons } from '@/components/reports/ExportButtons';
import { FlowChart, type FlowPoint } from '@/components/reports/FlowChart';
import { ReportPeriodFields } from '@/components/reports/ReportPeriodFields';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { usePnlReport } from '@/hooks/useReports';
import { useUrlFilters } from '@/hooks/useUrlFilters';
import { BUCKET_LABEL } from '@/lib/buckets';
import { cn } from '@/lib/cn';
import { reportCodec, reportPeriod, toPeriodParams } from '@/lib/report-filters';
import { txDrilldownHref } from '@/lib/tx-filters';
import type { BucketBreakdown, CompareMode, PnlBucket } from '@/lib/types';

type LinkHref = Parameters<typeof Link>[0]['href'];

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

  const points: FlowPoint[] =
    query.data?.primary.buckets.map((b) => ({
      label: b.label,
      income: b.income,
      expense: b.expense,
      line: b.net,
    })) ?? [];

  const totals = query.data?.primary.totals;
  // Сравнение живёт в плитках, а не на графике: «± к прошлому периоду».
  const cmp = compareWith !== 'none' ? query.data?.comparison?.totals : undefined;
  const cmpLabel = compareWith === 'yoy' ? 'к прошлому году' : 'к пред. периоду';
  const delta = (cur: string, prev: string | undefined) => {
    if (prev === undefined) return undefined;
    const d = sub(cur, prev);
    const sign = d.gt(0) ? '+' : d.lt(0) ? '−' : '';
    const pct = D(prev).isZero() ? null : d.div(D(prev)).mul(100).abs().toFixed(0);
    return `${sign}${formatRub(toMoneyString(d.abs()))}${pct !== null ? ` (${sign}${pct} %)` : ''} ${cmpLabel}`;
  };
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
        <FilterReset onClick={() => setFilters({ ...reportPeriod(DEFAULT_PERIOD), ...EXTRAS })} />
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
                  <KpiCard
                    label="Операционные доходы"
                    value={<Money value={totals.income} />}
                    tone="positive"
                    hint={delta(totals.income, cmp?.income)}
                  />
                  <KpiCard
                    label="Операционные расходы"
                    value={<Money value={totals.expense} />}
                    tone="negative"
                    hint={delta(totals.expense, cmp?.expense)}
                  />
                  <KpiCard
                    label="Чистая прибыль"
                    value={<Money value={totals.net} />}
                    tone={D(totals.net).gte(0) ? 'positive' : 'negative'}
                    hint={delta(totals.net, cmp?.net)}
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

        {/* Один график: доход и расход по периодам, линия — чистая прибыль. */}
        {!reportEmpty && (
          <FlowChart
            points={points}
            title="Доходы, расходы и прибыль"
            caption={groupBy === 'quarter' ? 'по кварталам' : 'по месяцам'}
            incomeLabel="Доходы"
            expenseLabel="Расходы"
            lineLabel="Чистая прибыль"
          />
        )}

        {/* IJ9: базис отчёта — по реализации (деньги — в ОДДС) */}
        {!reportEmpty && totals && groups.length > 0 && (
          <SectionCard title="По группам" aside="выручка и себестоимость — по дате закрытия заказа">
            <DataTable
              data={groups}
              columns={groupColumns}
              rowKey={(b) => b.bucket}
              mobileCards={groupCard}
            />
          </SectionCard>
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
