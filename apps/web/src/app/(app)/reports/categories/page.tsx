'use client';

import { useState } from 'react';
import { Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { formatRub } from '@construct/shared';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { PeriodPicker, periodToQuery, type PeriodValue } from '@/components/reports/PeriodPicker';
import { ExportButtons } from '@/components/reports/ExportButtons';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useBreakdownReport } from '@/hooks/useReports';

const COLORS = [
  '#3b82f6',
  '#10b981',
  '#f59e0b',
  '#8b5cf6',
  '#ef4444',
  '#06b6d4',
  '#a855f7',
  '#ec4899',
  '#84cc16',
  '#f97316',
];

export default function CategoriesReportPage() {
  const ws = useCurrentWorkspace();
  const wsId = ws.currentId;
  const [period, setPeriod] = useState<PeriodValue>({ mode: 'preset', preset: 'this-month' });
  const [type, setType] = useState<'INCOME' | 'EXPENSE' | 'ALL'>('EXPENSE');

  const query = useBreakdownReport('by-category', wsId, periodToQuery(period), type);

  if (!wsId) return <EmptyState title="Workspace не выбран" />;

  const top = (query.data?.rows ?? []).slice(0, 10);
  const pieData = top.map((r) => ({ name: r.name, value: Number(r.total) }));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PeriodPicker value={period} onChange={setPeriod} />
        <div className="flex items-center gap-2 text-sm">
          <label className="flex items-center gap-1">
            Тип:
            <select
              value={type}
              onChange={(e) => setType(e.target.value as 'INCOME' | 'EXPENSE' | 'ALL')}
              className="rounded border border-glass-border bg-glass/30 px-2 py-1"
            >
              <option value="EXPENSE">Расход</option>
              <option value="INCOME">Доход</option>
              <option value="ALL">Всё</option>
            </select>
          </label>
        </div>
        {wsId && (
          <ExportButtons
            wsId={wsId}
            kind="by-category"
            params={{ ...periodToQuery(period), type }}
          />
        )}
      </div>

      {query.isLoading && <p className="text-muted text-sm">Загрузка…</p>}

      {pieData.length > 0 && (
        <Card>
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
                <Tooltip formatter={(v) => formatRub(Number(v))} />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </Card>
      )}

      {query.data && (
        <Card>
          <table className="w-full text-sm">
            <thead className="text-muted text-left text-xs uppercase">
              <tr>
                <th className="py-2">Категория</th>
                <th className="py-2 text-right">Транзакций</th>
                <th className="py-2 text-right">Итого</th>
                <th className="py-2 text-right">Доля</th>
              </tr>
            </thead>
            <tbody>
              {query.data.rows.map((r) => (
                <tr key={r.id ?? 'none'} className="border-t border-glass-border">
                  <td className="py-2">{r.name}</td>
                  <td className="py-2 text-right">{r.count}</td>
                  <td className="py-2 text-right font-medium">{formatRub(r.total)}</td>
                  <td className="py-2 text-right text-muted">{(r.share * 100).toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
