'use client';

import { Suspense } from 'react';
import { D, formatRub } from '@construct/shared';
import { Money } from '@/components/ui/Money';
import { Card } from '@/components/ui/Card';
import { KpiCard } from '@/components/ui/KpiCard';
import { KpiRow } from '@/components/ui/KpiRow';
import { ErrorState } from '@/components/ui/ErrorState';
import { FilterBar, FilterReset } from '@/components/ui/FilterBar';
import { ReportPeriodFields } from '@/components/reports/ReportPeriodFields';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useBreakevenReport } from '@/hooks/useReports';
import { useUrlFilters } from '@/hooks/useUrlFilters';
import { cn } from '@/lib/cn';
import { reportCodec, reportPeriod, toPeriodParams } from '@/lib/report-filters';

const DEFAULT_PERIOD = 'this-month';
const CODEC = reportCodec(DEFAULT_PERIOD, {});

// useSearchParams требует Suspense-границу на уровне page (Next 14 App Router).
export default function BreakevenPage() {
  return (
    <Suspense>
      <BreakevenView />
    </Suspense>
  );
}

/**
 * Точка безубыточности: при какой выручке за период прибыль равна нулю.
 * Методология та же, что в ОПиУ (IJ9): выручка/себестоимость по закрытию
 * заказов, зарплата — в постоянных, налог вне формулы.
 */
function BreakevenView() {
  const { currentId: wsId } = useCurrentWorkspace();
  const [filters, setFilters] = useUrlFilters(CODEC);

  const query = useBreakevenReport(wsId, toPeriodParams(filters));

  if (!wsId) return null;

  const r = query.data;
  const achieved = r?.achievedPct ?? null;

  return (
    <>
      <FilterBar>
        <ReportPeriodFields value={filters} onChange={(p) => setFilters({ ...filters, ...p })} />
        <FilterReset onClick={() => setFilters(reportPeriod(DEFAULT_PERIOD))} />
      </FilterBar>

      <div className="space-y-6 px-6 py-6">
        <p className="max-w-3xl text-sm text-muted-foreground">
          Точка безубыточности — выручка, при которой прибыль за период равна нулю:
          постоянные расходы ÷ доля маржинального дохода. Всё, что выше точки, приносит прибыль.
        </p>

        {query.isError ? (
          <ErrorState error={query.error} onRetry={() => query.refetch()} />
        ) : (
          <KpiRow loading={query.isLoading || !r} count={3}>
            {r && (
              <>
                <KpiCard
                  label="Точка безубыточности"
                  value={r.breakevenRevenue ? <Money value={r.breakevenRevenue} /> : '—'}
                  hint={
                    r.breakevenRevenue
                      ? 'выручка, при которой прибыль = 0'
                      : D(r.revenue).isZero()
                        ? 'нет выручки за период'
                        : 'переменные расходы не ниже выручки'
                  }
                  size="display"
                  className="sm:col-span-2"
                />
                <KpiCard
                  label="Запас прочности"
                  value={r.safetyMarginPct != null ? `${r.safetyMarginPct}%` : '—'}
                  tone={
                    r.safetyMarginPct == null
                      ? 'neutral'
                      : r.safetyMarginPct >= 0
                        ? 'positive'
                        : 'negative'
                  }
                  hint="насколько выручка выше точки"
                />
              </>
            )}
          </KpiRow>
        )}

        {r && (
          <>
            {/* Прогресс прохождения точки */}
            {r.breakevenRevenue && (
              <Card className="space-y-2 p-4">
                <div className="flex items-baseline justify-between text-sm">
                  <span className="font-medium">
                    Пройдено {achieved != null ? `${achieved}%` : '—'} точки безубыточности
                  </span>
                  <span className="text-muted-foreground">
                    <Money value={r.revenue} tone="plain" /> из{' '}
                    <Money value={r.breakevenRevenue} tone="plain" />
                  </span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-border/60">
                  <div
                    className={cn(
                      'h-full rounded-full transition-all',
                      achieved != null && achieved >= 100 ? 'bg-success' : 'bg-warning',
                    )}
                    style={{ width: `${Math.max(0, Math.min(100, achieved ?? 0))}%` }}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  {achieved != null && achieved >= 100
                    ? 'Точка пройдена — дальнейшая выручка формирует прибыль.'
                    : 'Точка ещё не пройдена — прибыль за период пока отрицательная.'}
                </p>
              </Card>
            )}

            {/* Состав формулы */}
            <Card className="!p-0 overflow-hidden">
              <header className="border-b border-border px-4 py-3">
                <h3 className="font-medium">Составляющие расчёта</h3>
              </header>
              <div className="divide-y divide-border/60 text-sm">
                <FormulaRow label="Выручка (по закрытым заказам)" value={r.revenue} />
                <FormulaRow
                  label="Переменные расходы"
                  value={r.variableCosts.total}
                  negative
                />
                <FormulaRow
                  label="Себестоимость проданного"
                  value={r.variableCosts.cogs}
                  nested
                />
                <FormulaRow label="Переменные статьи" value={r.variableCosts.variable} nested />
                <FormulaRow
                  label={`Маржинальный доход${
                    r.contributionMarginPct != null ? ` (${r.contributionMarginPct}%)` : ''
                  }`}
                  value={r.contributionMargin}
                  strong
                />
                <FormulaRow
                  label="Постоянные расходы (включая зарплату)"
                  value={r.fixedCosts}
                  negative
                />
              </div>
            </Card>

            <p className="text-xs text-muted-foreground">
              Методология ОПиУ: выручка и себестоимость — по дате закрытия заказа, возвраты
              минусуются своим месяцем. Налог (АУСН) в формуле не участвует — он зависит от
              прибыли. Постоянные и переменные статьи определяются категорией операции или её
              видом.
            </p>
          </>
        )}
      </div>
    </>
  );
}

function FormulaRow({
  label,
  value,
  nested,
  negative,
  strong,
}: {
  label: string;
  value: string;
  nested?: boolean;
  negative?: boolean;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-4 py-2.5">
      <span
        className={cn(
          'min-w-0 truncate',
          nested && 'pl-5 text-muted-foreground',
          strong && 'font-medium',
        )}
      >
        {label}
      </span>
      <span
        className={cn(
          'num shrink-0',
          nested ? 'text-muted-foreground' : 'font-medium',
          negative && 'text-destructive',
          strong && D(value).lt(0) && 'text-destructive',
        )}
      >
        {negative ? `(${formatRub(value)})` : formatRub(value)}
      </span>
    </div>
  );
}
