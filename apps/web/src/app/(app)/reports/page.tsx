'use client';

import { useState } from 'react';
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
import { BarChart3 } from 'lucide-react';
import { formatRub } from '@construct/shared';
import { Card } from '@/components/ui/Card';
import { KpiCard } from '@/components/ui/KpiCard';
import { EmptyState } from '@/components/ui/EmptyState';
import { Select } from '@/components/ui/Select';
import { FilterBar } from '@/components/ui/FilterBar';
import { Skeleton } from '@/components/ui/Skeleton';
import {
  PeriodPicker,
  periodToQuery,
  type PeriodValue,
} from '@/components/reports/PeriodPicker';
import { ExportButtons } from '@/components/reports/ExportButtons';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { usePnlReport } from '@/hooks/useReports';
import type { CompareMode } from '@/lib/types';
import { cn } from '@/lib/cn';

const CHART_COLORS = {
  income: '#157347',
  expense: '#C72A2A',
  incomeCmp: '#86b69e',
  expenseCmp: '#e09898',
};

export default function PnlReportPage() {
  const ws = useCurrentWorkspace();
  const wsId = ws.currentId;
  const [period, setPeriod] = useState<PeriodValue>({
    mode: 'preset',
    preset: 'this-year',
  });
  const [groupBy, setGroupBy] = useState<'month' | 'quarter'>('month');
  const [compareWith, setCompareWith] = useState<CompareMode>('none');

  const query = usePnlReport(wsId, periodToQuery(period), groupBy, compareWith);

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

  const data =
    query.data?.primary.buckets.map((b, i) => ({
      label: b.label,
      Доход: Number(b.income),
      Расход: -Number(b.expense),
      cmpDoxod: query.data?.comparison
        ? Number(query.data.comparison.buckets[i]?.income ?? 0)
        : undefined,
      cmpRashod: query.data?.comparison
        ? -Number(query.data.comparison.buckets[i]?.expense ?? 0)
        : undefined,
    })) ?? [];

  const totals = query.data?.primary.totals;

  return (
    <>
      <FilterBar>
        <PeriodPicker value={period} onChange={setPeriod} />
        <label className="flex flex-col text-xs text-muted-foreground">
          <span className="pb-1">Группировка</span>
          <Select
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value as 'month' | 'quarter')}
            className="h-9 w-[120px]"
          >
            <option value="month">Месяц</option>
            <option value="quarter">Квартал</option>
          </Select>
        </label>
        <label className="flex flex-col text-xs text-muted-foreground">
          <span className="pb-1">Сравнить</span>
          <Select
            value={compareWith}
            onChange={(e) => setCompareWith(e.target.value as CompareMode)}
            className="h-9 w-[160px]"
          >
            <option value="none">—</option>
            <option value="prev">Пред. период</option>
            <option value="yoy">Год к году</option>
          </Select>
        </label>
        <div className="ml-auto self-end">
          <ExportButtons
            wsId={wsId}
            kind="pnl"
            params={{ ...periodToQuery(period), groupBy }}
          />
        </div>
      </FilterBar>

      <div className="space-y-4 px-6 py-4">
        {query.isLoading ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <Skeleton className="h-[88px]" />
            <Skeleton className="h-[88px]" />
            <Skeleton className="h-[88px]" />
          </div>
        ) : query.isError ? (
          <p className="text-sm text-destructive">Не удалось загрузить отчёт.</p>
        ) : totals ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <KpiCard label="Доход" value={formatRub(totals.income)} tone="positive" />
            <KpiCard label="Расход" value={formatRub(totals.expense)} tone="negative" />
            <KpiCard
              label="Чистая прибыль"
              value={formatRub(totals.net)}
              tone={Number(totals.net) >= 0 ? 'positive' : 'negative'}
            />
          </div>
        ) : null}

        {data.length > 0 && (
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
                  <Bar dataKey="Доход" fill={CHART_COLORS.income} radius={[2, 2, 0, 0]} />
                  <Bar dataKey="Расход" fill={CHART_COLORS.expense} radius={[2, 2, 0, 0]} />
                  {compareWith !== 'none' && (
                    <>
                      <Bar
                        dataKey="cmpDoxod"
                        name="Доход (сравн.)"
                        fill={CHART_COLORS.incomeCmp}
                        radius={[2, 2, 0, 0]}
                      />
                      <Bar
                        dataKey="cmpRashod"
                        name="Расход (сравн.)"
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

        {query.data && query.data.primary.buckets.length > 0 && (
          <Card className="overflow-x-auto !p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-border">
                <tr className="text-left text-xs uppercase text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Период</th>
                  <th className="px-4 py-2 text-right font-medium">Доход</th>
                  <th className="px-4 py-2 text-right font-medium">Расход</th>
                  <th className="px-4 py-2 text-right font-medium">Чистая</th>
                </tr>
              </thead>
              <tbody>
                {query.data.primary.buckets.map((b) => (
                  <tr key={b.label} className="border-b border-border last:border-0">
                    <td className="px-4 py-2">{b.label}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-success">
                      {formatRub(b.income)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-destructive">
                      {formatRub(b.expense)}
                    </td>
                    <td
                      className={cn(
                        'px-4 py-2 text-right font-medium tabular-nums',
                        Number(b.net) >= 0 ? 'text-success' : 'text-destructive',
                      )}
                    >
                      {formatRub(b.net)}
                    </td>
                  </tr>
                ))}
              </tbody>
              {totals && (
                <tfoot className="bg-secondary/40">
                  <tr className="font-semibold">
                    <td className="px-4 py-2">Итого</td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {formatRub(totals.income)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {formatRub(totals.expense)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {formatRub(totals.net)}
                    </td>
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
