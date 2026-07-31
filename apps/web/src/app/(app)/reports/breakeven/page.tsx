'use client';

import { useState } from 'react';
import { formatRub } from '@construct/shared';
import { Calculator } from '@/components/ui/icons';
import { Card } from '@/components/ui/Card';
import { KpiCard } from '@/components/ui/KpiCard';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { FilterBar } from '@/components/ui/FilterBar';
import { PeriodPicker, periodToQuery, type PeriodValue } from '@/components/reports/PeriodPicker';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useBreakevenReport } from '@/hooks/useReports';
import { cn } from '@/lib/cn';

/**
 * Точка безубыточности: при какой выручке за период прибыль равна нулю.
 * Методология та же, что в ОПиУ (IJ9): выручка/себестоимость по закрытию
 * заказов, зарплата — в постоянных, налог вне формулы.
 */
export default function BreakevenPage() {
  const ws = useCurrentWorkspace();
  const wsId = ws.currentId;
  const [period, setPeriod] = useState<PeriodValue>({ mode: 'preset', preset: 'this-month' });

  const query = useBreakevenReport(wsId, periodToQuery(period));

  if (!wsId) {
    return (
      <div className="p-6">
        <EmptyState
          icon={Calculator}
          title="Нет активного пространства"
          hint="Выберите или создайте пространство."
        />
      </div>
    );
  }

  const r = query.data;
  const achieved = r?.achievedPct ?? null;

  return (
    <>
      <FilterBar>
        <PeriodPicker value={period} onChange={setPeriod} />
      </FilterBar>

      <div className="space-y-6 px-6 py-6">
        <p className="max-w-3xl text-sm text-muted-foreground">
          Точка безубыточности — выручка, при которой прибыль за период равна нулю:
          постоянные расходы ÷ доля маржинального дохода. Всё, что выше точки, приносит прибыль.
        </p>

        {query.isLoading || !r ? (
          <div className="grid gap-4 sm:grid-cols-3">
            <Skeleton className="h-[124px]" />
            <Skeleton className="h-[124px]" />
            <Skeleton className="h-[124px]" />
          </div>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              <KpiCard
                label="Точка безубыточности"
                value={r.breakevenRevenue ? formatRub(r.breakevenRevenue) : '—'}
                hint={
                  r.breakevenRevenue
                    ? 'выручка, при которой прибыль = 0'
                    : Number(r.revenue) === 0
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
            </div>

            {/* Прогресс прохождения точки */}
            {r.breakevenRevenue && (
              <Card className="space-y-2 p-4">
                <div className="flex items-baseline justify-between text-sm">
                  <span className="font-medium">
                    Пройдено {achieved != null ? `${achieved}%` : '—'} точки безубыточности
                  </span>
                  <span className="num text-muted-foreground">
                    {formatRub(r.revenue)} из {formatRub(r.breakevenRevenue)}
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
          strong && Number(value) < 0 && 'text-destructive',
        )}
      >
        {negative ? `(${formatRub(value)})` : formatRub(value)}
      </span>
    </div>
  );
}
