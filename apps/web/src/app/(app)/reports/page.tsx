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
import { formatRub } from '@construct/shared';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { PeriodPicker, periodToQuery, type PeriodValue } from '@/components/reports/PeriodPicker';
import { ExportButtons } from '@/components/reports/ExportButtons';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { usePnlReport } from '@/hooks/useReports';
import type { CompareMode } from '@/lib/types';

export default function PnlReportPage() {
  const ws = useCurrentWorkspace();
  const wsId = ws.currentId;
  const [period, setPeriod] = useState<PeriodValue>({ mode: 'preset', preset: 'this-year' });
  const [groupBy, setGroupBy] = useState<'month' | 'quarter'>('month');
  const [compareWith, setCompareWith] = useState<CompareMode>('none');

  const query = usePnlReport(wsId, periodToQuery(period), groupBy, compareWith);

  if (!wsId) return <EmptyState title="Workspace не выбран" />;

  const data =
    query.data?.primary.buckets.map((b, i) => ({
      label: b.label,
      Доход: Number(b.income),
      Расход: -Number(b.expense),
      Чистая: Number(b.net),
      cmpDoxod: query.data?.comparison
        ? Number(query.data.comparison.buckets[i]?.income ?? 0)
        : undefined,
      cmpRashod: query.data?.comparison
        ? -Number(query.data.comparison.buckets[i]?.expense ?? 0)
        : undefined,
    })) ?? [];

  const totals = query.data?.primary.totals;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PeriodPicker value={period} onChange={setPeriod} />
        <div className="flex items-center gap-2 text-sm">
          <label className="flex items-center gap-1">
            Группировка:
            <select
              value={groupBy}
              onChange={(e) => setGroupBy(e.target.value as 'month' | 'quarter')}
              className="rounded border border-glass-border bg-glass/30 px-2 py-1"
            >
              <option value="month">Месяц</option>
              <option value="quarter">Квартал</option>
            </select>
          </label>
          <label className="flex items-center gap-1">
            Сравнить:
            <select
              value={compareWith}
              onChange={(e) => setCompareWith(e.target.value as CompareMode)}
              className="rounded border border-glass-border bg-glass/30 px-2 py-1"
            >
              <option value="none">—</option>
              <option value="prev">Пред. период</option>
              <option value="yoy">Год к году</option>
            </select>
          </label>
        </div>
        {wsId && (
          <ExportButtons
            wsId={wsId}
            kind="pnl"
            params={{ ...periodToQuery(period), groupBy }}
          />
        )}
      </div>

      {query.isLoading && <p className="text-muted text-sm">Загрузка…</p>}
      {query.isError && <p className="text-red-500 text-sm">Не удалось загрузить отчёт.</p>}

      {totals && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          <Card>
            <p className="text-muted text-xs uppercase">Доход</p>
            <p className="text-lg font-semibold text-emerald-500">{formatRub(totals.income)}</p>
          </Card>
          <Card>
            <p className="text-muted text-xs uppercase">Расход</p>
            <p className="text-lg font-semibold text-rose-500">{formatRub(totals.expense)}</p>
          </Card>
          <Card>
            <p className="text-muted text-xs uppercase">Чистая прибыль</p>
            <p
              className={`text-lg font-semibold ${
                Number(totals.net) >= 0 ? 'text-emerald-500' : 'text-rose-500'
              }`}
            >
              {formatRub(totals.net)}
            </p>
          </Card>
        </div>
      )}

      {data.length > 0 && (
        <Card>
          <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                <XAxis dataKey="label" />
                <YAxis tickFormatter={(v) => new Intl.NumberFormat('ru-RU').format(Number(v))} />
                <Tooltip
                  formatter={(v) => formatRub(Math.abs(Number(v)))}
                  labelStyle={{ color: '#000' }}
                />
                <Legend />
                <Bar dataKey="Доход" fill="#10b981" />
                <Bar dataKey="Расход" fill="#f43f5e" />
                {compareWith !== 'none' && (
                  <>
                    <Bar dataKey="cmpDoxod" name="Доход (сравн.)" fill="#6ee7b7" />
                    <Bar dataKey="cmpRashod" name="Расход (сравн.)" fill="#fda4af" />
                  </>
                )}
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      )}

      {query.data && query.data.primary.buckets.length > 0 && (
        <Card>
          <table className="w-full text-sm">
            <thead className="text-muted text-left text-xs uppercase">
              <tr>
                <th className="py-2">Период</th>
                <th className="py-2 text-right">Доход</th>
                <th className="py-2 text-right">Расход</th>
                <th className="py-2 text-right">Чистая</th>
              </tr>
            </thead>
            <tbody>
              {query.data.primary.buckets.map((b) => (
                <tr key={b.label} className="border-t border-glass-border">
                  <td className="py-2">{b.label}</td>
                  <td className="py-2 text-right text-emerald-500">{formatRub(b.income)}</td>
                  <td className="py-2 text-right text-rose-500">{formatRub(b.expense)}</td>
                  <td
                    className={`py-2 text-right font-medium ${
                      Number(b.net) >= 0 ? 'text-emerald-500' : 'text-rose-500'
                    }`}
                  >
                    {formatRub(b.net)}
                  </td>
                </tr>
              ))}
            </tbody>
            {totals && (
              <tfoot>
                <tr className="border-t border-glass-border font-semibold">
                  <td className="py-2">Итого</td>
                  <td className="py-2 text-right">{formatRub(totals.income)}</td>
                  <td className="py-2 text-right">{formatRub(totals.expense)}</td>
                  <td className="py-2 text-right">{formatRub(totals.net)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </Card>
      )}
    </div>
  );
}
