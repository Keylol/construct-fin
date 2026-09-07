'use client';

import { useState } from 'react';
import Link from 'next/link';
import { BarChart3 } from '@/components/ui/icons';
import { Money } from '@/components/ui/Money';

import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { FilterBar } from '@/components/ui/FilterBar';
import { PeriodPicker, periodToQuery, type PeriodValue } from '@/components/reports/PeriodPicker';
import { ExportButtons } from '@/components/reports/ExportButtons';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useBreakdownReport } from '@/hooks/useReports';
import { txDrilldownHref } from '@/lib/tx-filters';
import { CategoryDonut, donutKey, donutSlices } from '@/components/reports/CategoryDonut';
import { CHART_OTHER } from '@/lib/chart';

export default function CategoriesReportPage() {
  const ws = useCurrentWorkspace();
  const wsId = ws.currentId;
  const [period, setPeriod] = useState<PeriodValue>({
    mode: 'preset',
    preset: 'this-month',
  });
  const [type, setType] = useState<'INCOME' | 'EXPENSE' | 'ALL'>('EXPENSE');

  const query = useBreakdownReport('by-category', wsId, periodToQuery(period), type);

  if (!wsId) return null;

  const rows = query.data?.rows ?? [];
  // Цвет сектора ↔ маркер строки: один источник (donutSlices, фиксированный порядок).
  const sliceColorByKey = new Map(donutSlices(rows).map((s) => [s.key, s.color]));

  return (
    <>
      <FilterBar>
        <PeriodPicker value={period} onChange={setPeriod} />
        <label className="flex flex-col text-xs text-muted-foreground">
          <span className="pb-1">Тип</span>
          <Select
            value={type}
            onChange={(e) => setType(e.target.value as 'INCOME' | 'EXPENSE' | 'ALL')}
            className="h-9 w-[120px]"
          >
            <option value="EXPENSE">Расход</option>
            <option value="INCOME">Доход</option>
            <option value="ALL">Всё</option>
          </Select>
        </label>
        <div className="ml-auto self-end">
          <ExportButtons
            wsId={wsId}
            kind="by-category"
            params={{ ...periodToQuery(period), type }}
          />
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

        {/* Доля — полосой прямо в строке (дублирует donut числами: мелкие
            категории читаются, а цветной маркер связывает строку с сектором). */}
        {query.data && rows.length > 0 && (
          <Card className="overflow-x-auto !p-0">
            <table className="w-full text-base">
              <thead className="border-b border-border">
                <tr className="text-left text-xs uppercase text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Категория</th>
                  <th className="w-[110px] px-4 py-2 text-right font-medium">Операций</th>
                  <th className="w-[170px] px-4 py-2 text-right font-medium">Итого</th>
                  <th className="w-[90px] px-4 py-2 text-right font-medium">Доля</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.id ?? 'none'}
                    className="border-b border-border transition-colors last:border-0 hover:bg-secondary/50"
                  >
                    <td className="px-4 py-2.5">
                      <span
                        className="mr-2 inline-block h-2.5 w-2.5 translate-y-px rounded-[3px]"
                        style={{
                          // Мелкие категории свёрнуты в сектор «Прочее» — тот же серый.
                          background: sliceColorByKey.get(donutKey(r)) ?? CHART_OTHER,
                        }}
                        aria-hidden
                      />
                      {r.id !== null ? (
                        <Link
                          href={
                            txDrilldownHref({
                              categoryId: r.id,
                              from: query.data!.period.from,
                              to: query.data!.period.to,
                              type: type === 'ALL' ? undefined : type,
                            }) as Parameters<typeof Link>[0]['href']
                          }
                          className="cursor-pointer hover:underline"
                        >
                          {r.name}
                        </Link>
                      ) : (
                        r.name
                      )}
                      <div className="mt-1.5 h-1 w-full max-w-[360px] overflow-hidden rounded-full bg-border/50">
                        <div
                          className="h-full rounded-full bg-primary/70"
                          // Доля честная (от 100%); минимум 1% — чтобы мелкие были видны.
                          style={{ width: `${Math.max(r.share * 100, 1)}%` }}
                        />
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{r.count}</td>
                    <td className="px-4 py-2.5 text-right font-medium"><Money value={r.total} /></td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                      {(r.share * 100).toFixed(1)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>
    </>
  );
}
