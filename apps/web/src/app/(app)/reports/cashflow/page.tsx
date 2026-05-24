'use client';

import { useState, useMemo } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
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
import { useCashflowReport } from '@/hooks/useReports';
import { useAccounts } from '@/hooks/useAccounts';

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444', '#06b6d4'];

export default function CashflowReportPage() {
  const ws = useCurrentWorkspace();
  const wsId = ws.currentId;
  const [period, setPeriod] = useState<PeriodValue>({ mode: 'preset', preset: 'this-year' });
  const [accountId, setAccountId] = useState<string | null>(null);

  const accounts = useAccounts(wsId);
  const query = useCashflowReport(wsId, periodToQuery(period), accountId);

  const chartData = useMemo(() => {
    if (!query.data) return [];
    const labels = new Set<string>();
    for (const s of query.data.series) for (const p of s.points) labels.add(p.label);
    const sorted = Array.from(labels).sort();
    return sorted.map((label) => {
      const row: Record<string, string | number> = { label };
      for (const s of query.data!.series) {
        const point = s.points.find((p) => p.label === label);
        row[s.accountName ?? 'Без счёта'] = point ? Number(point.balance) : 0;
      }
      return row;
    });
  }, [query.data]);

  if (!wsId) return <EmptyState title="Workspace не выбран" />;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PeriodPicker value={period} onChange={setPeriod} />
        <div className="flex items-center gap-2 text-sm">
          <label className="flex items-center gap-1">
            Счёт:
            <select
              value={accountId ?? ''}
              onChange={(e) => setAccountId(e.target.value || null)}
              className="rounded border border-glass-border bg-glass/30 px-2 py-1"
            >
              <option value="">Все счета</option>
              {accounts.data?.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {wsId && (
          <ExportButtons
            wsId={wsId}
            kind="cashflow"
            params={{ ...periodToQuery(period), accountId: accountId ?? undefined }}
          />
        )}
      </div>

      {query.isLoading && <p className="text-muted text-sm">Загрузка…</p>}

      {chartData.length > 0 && (
        <Card>
          <div className="h-80 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                <XAxis dataKey="label" />
                <YAxis tickFormatter={(v) => new Intl.NumberFormat('ru-RU').format(Number(v))} />
                <Tooltip formatter={(v) => formatRub(Number(v))} labelStyle={{ color: '#000' }} />
                <Legend />
                {query.data?.series.map((s, i) => (
                  <Line
                    key={s.accountId ?? i}
                    type="monotone"
                    dataKey={s.accountName ?? 'Без счёта'}
                    stroke={COLORS[i % COLORS.length]}
                    strokeWidth={2}
                    dot={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>
      )}

      {query.data && (
        <div className="grid gap-4 md:grid-cols-2">
          {query.data.series.map((s) => (
            <Card key={s.accountId ?? 'none'}>
              <header className="flex items-baseline justify-between">
                <h3 className="font-medium">{s.accountName ?? 'Без счёта'}</h3>
                <span className="text-muted text-xs">
                  Старт: {formatRub(s.openingBalance)}
                </span>
              </header>
              <table className="mt-2 w-full text-sm">
                <thead className="text-muted text-left text-xs uppercase">
                  <tr>
                    <th className="py-1">Период</th>
                    <th className="py-1 text-right">Приход</th>
                    <th className="py-1 text-right">Расход</th>
                    <th className="py-1 text-right">Остаток</th>
                  </tr>
                </thead>
                <tbody>
                  {s.points.map((p) => (
                    <tr key={p.label} className="border-t border-glass-border">
                      <td className="py-1">{p.label}</td>
                      <td className="py-1 text-right text-emerald-500">{formatRub(p.inflow)}</td>
                      <td className="py-1 text-right text-rose-500">{formatRub(p.outflow)}</td>
                      <td className="py-1 text-right font-medium">{formatRub(p.balance)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
