'use client';

import { useState } from 'react';
import { BarChart3 } from 'lucide-react';
import { formatRub } from '@construct/shared';
import { Card } from '@/components/ui/Card';
import { KpiCard } from '@/components/ui/KpiCard';
import { EmptyState } from '@/components/ui/EmptyState';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { FilterBar } from '@/components/ui/FilterBar';
import { PeriodPicker, periodToQuery, type PeriodValue } from '@/components/reports/PeriodPicker';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useMarginReport } from '@/hooks/useTradeReports';
import { cn } from '@/lib/cn';

type Method = 'by-product' | 'by-client';

export default function MarginReportPage() {
  const ws = useCurrentWorkspace();
  const wsId = ws.currentId;
  const [period, setPeriod] = useState<PeriodValue>({ mode: 'preset', preset: 'this-year' });
  const [method, setMethod] = useState<Method>('by-product');

  const query = useMarginReport(method, wsId, periodToQuery(period));

  if (!wsId) {
    return (
      <div className="p-6">
        <EmptyState
          icon={BarChart3}
          title="Нет активного пространства"
          hint="Выберите или создайте пространство."
        />
      </div>
    );
  }

  const totals = query.data?.totals;
  const rows = query.data?.rows ?? [];
  const isProduct = method === 'by-product';

  return (
    <>
      <FilterBar>
        <PeriodPicker value={period} onChange={setPeriod} />
        <label className="flex flex-col text-xs text-muted-foreground">
          <span className="pb-1">Разрез</span>
          <Select
            value={method}
            onChange={(e) => setMethod(e.target.value as Method)}
            className="h-9 w-[160px]"
          >
            <option value="by-product">По товарам</option>
            <option value="by-client">По клиентам</option>
          </Select>
        </label>
      </FilterBar>

      <div className="space-y-4 px-6 py-4">
        {query.isLoading ? (
          <div className="grid gap-3 sm:grid-cols-4">
            <Skeleton className="h-[88px]" />
            <Skeleton className="h-[88px]" />
            <Skeleton className="h-[88px]" />
            <Skeleton className="h-[88px]" />
          </div>
        ) : query.isError ? (
          <p className="text-sm text-destructive">Не удалось загрузить отчёт.</p>
        ) : totals ? (
          <div className="stagger grid gap-4 sm:grid-cols-4">
            <KpiCard label="Выручка" value={formatRub(totals.revenue)} tone="positive" />
            <KpiCard label="Себестоимость" value={formatRub(totals.cogs)} tone="negative" />
            <KpiCard
              label="Валовая прибыль"
              value={formatRub(totals.margin)}
              tone={Number(totals.margin) >= 0 ? 'positive' : 'negative'}
            />
            <KpiCard label="Рентабельность, %" value={`${totals.marginPct}%`} />
          </div>
        ) : null}

        {query.data && (
          <Card className="overflow-x-auto !p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-border">
                <tr className="text-left text-xs uppercase text-muted-foreground">
                  <th className="px-4 py-2 font-medium">{isProduct ? 'Товар' : 'Клиент'}</th>
                  {isProduct && <th className="px-4 py-2 text-right font-medium">Кол-во</th>}
                  <th className="px-4 py-2 text-right font-medium">Выручка</th>
                  <th className="px-4 py-2 text-right font-medium">Себестоимость</th>
                  <th className="px-4 py-2 text-right font-medium">Вал. прибыль</th>
                  <th className="px-4 py-2 text-right font-medium">Рент., %</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={isProduct ? 6 : 5}
                      className="px-4 py-8 text-center text-muted-foreground"
                    >
                      Нет закрытых заказов за период.
                    </td>
                  </tr>
                ) : (
                  rows.map((r, i) => (
                    <tr key={r.key ?? `${r.name}-${i}`} className="border-b border-border last:border-0">
                      <td className="px-4 py-2">{r.name}</td>
                      {isProduct && (
                        <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                          {r.qty}
                        </td>
                      )}
                      <td className="px-4 py-2 text-right tabular-nums text-success">
                        {formatRub(r.revenue)}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-destructive">
                        {formatRub(r.cogs)}
                      </td>
                      <td
                        className={cn(
                          'px-4 py-2 text-right font-medium tabular-nums',
                          Number(r.margin) >= 0 ? 'text-success' : 'text-destructive',
                        )}
                      >
                        {formatRub(r.margin)}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                        {r.marginPct}%
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
              {totals && rows.length > 0 && (
                <tfoot className="bg-secondary/40">
                  <tr className="font-semibold">
                    <td className="px-4 py-2">Итого</td>
                    {isProduct && <td />}
                    <td className="px-4 py-2 text-right tabular-nums">{formatRub(totals.revenue)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatRub(totals.cogs)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatRub(totals.margin)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{totals.marginPct}%</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </Card>
        )}
      </div>
    </>
  );
}
