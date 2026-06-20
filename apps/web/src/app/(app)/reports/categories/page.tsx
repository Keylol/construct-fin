'use client';

import { useState } from 'react';
import { Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { BarChart3 } from 'lucide-react';
import { formatRub } from '@construct/shared';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { FilterBar } from '@/components/ui/FilterBar';
import { PeriodPicker, periodToQuery, type PeriodValue } from '@/components/reports/PeriodPicker';
import { ExportButtons } from '@/components/reports/ExportButtons';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useBreakdownReport } from '@/hooks/useReports';

const COLORS = [
  '#1B3A57',
  '#157347',
  '#B45309',
  '#6D28D9',
  '#C72A2A',
  '#0891B2',
  '#9333EA',
  '#DB2777',
  '#65A30D',
  '#EA580C',
];

export default function CategoriesReportPage() {
  const ws = useCurrentWorkspace();
  const wsId = ws.currentId;
  const [period, setPeriod] = useState<PeriodValue>({
    mode: 'preset',
    preset: 'this-month',
  });
  const [type, setType] = useState<'INCOME' | 'EXPENSE' | 'ALL'>('EXPENSE');

  const query = useBreakdownReport('by-category', wsId, periodToQuery(period), type);

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

  const top = (query.data?.rows ?? []).slice(0, 10);
  const pieData = top.map((r) => ({ name: r.name, value: Number(r.total) }));

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

        {pieData.length > 0 && (
          <Card className="!p-3">
            <div className="h-80 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={pieData}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    outerRadius={110}
                    label={(d) =>
                      `${d.name}: ${((Number(d.value) / pieData.reduce((s, p) => s + p.value, 0)) * 100).toFixed(0)}%`
                    }
                  >
                    {pieData.map((_, i) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(v) => formatRub(Number(v))}
                    contentStyle={{
                      borderRadius: 6,
                      border: '1px solid hsl(var(--border))',
                      background: 'hsl(var(--card))',
                      fontSize: 12,
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </Card>
        )}

        {query.data && (
          <Card className="overflow-x-auto !p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-border">
                <tr className="text-left text-xs uppercase text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Категория</th>
                  <th className="px-4 py-2 text-right font-medium">Операций</th>
                  <th className="px-4 py-2 text-right font-medium">Итого</th>
                  <th className="px-4 py-2 text-right font-medium">Доля</th>
                </tr>
              </thead>
              <tbody>
                {query.data.rows.map((r) => (
                  <tr key={r.id ?? 'none'} className="border-b border-border last:border-0">
                    <td className="px-4 py-2">{r.name}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{r.count}</td>
                    <td className="px-4 py-2 text-right font-medium tabular-nums">
                      {formatRub(r.total)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
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
