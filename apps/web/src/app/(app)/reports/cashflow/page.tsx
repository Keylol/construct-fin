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
import { useCashflowReport } from '@/hooks/useReports';
import { useAccounts } from '@/hooks/useAccounts';

const COLORS = ['#1B3A57', '#157347', '#B45309', '#6D28D9', '#C72A2A', '#0891B2'];

export default function CashflowReportPage() {
  const ws = useCurrentWorkspace();
  const wsId = ws.currentId;
  const [period, setPeriod] = useState<PeriodValue>({
    mode: 'preset',
    preset: 'this-year',
  });
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

  return (
    <>
      <FilterBar>
        <PeriodPicker value={period} onChange={setPeriod} />
        <label className="flex flex-col text-xs text-muted-foreground">
          <span className="pb-1">Счёт</span>
          <Select
            value={accountId ?? ''}
            onChange={(e) => setAccountId(e.target.value || null)}
            className="h-9 w-[180px]"
          >
            <option value="">Все счета</option>
            {accounts.data?.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </label>
        <div className="ml-auto self-end">
          <ExportButtons
            wsId={wsId}
            kind="cashflow"
            params={{ ...periodToQuery(period), accountId: accountId ?? undefined }}
          />
        </div>
      </FilterBar>

      <div className="space-y-4 px-6 py-4">
        {query.isLoading && <Skeleton className="h-80 w-full" />}

        {chartData.length > 0 && (
          <Card className="!p-3">
            <div className="h-80 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
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
                    formatter={(v) => formatRub(Number(v))}
                    contentStyle={{
                      borderRadius: 6,
                      border: '1px solid hsl(var(--border))',
                      background: 'hsl(var(--card))',
                      fontSize: 12,
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
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
          <div className="grid gap-3 md:grid-cols-2">
            {query.data.series.map((s) => (
              <Card key={s.accountId ?? 'none'} className="!p-0 overflow-hidden">
                <header className="flex items-baseline justify-between border-b border-border px-4 py-3">
                  <h3 className="font-medium">{s.accountName ?? 'Без счёта'}</h3>
                  <span className="text-xs text-muted-foreground">
                    Старт: <span className="tabular-nums">{formatRub(s.openingBalance)}</span>
                  </span>
                </header>
                <table className="w-full text-sm">
                  <thead className="border-b border-border">
                    <tr className="text-left text-xs uppercase text-muted-foreground">
                      <th className="px-3 py-2 font-medium">Период</th>
                      <th className="px-3 py-2 text-right font-medium">Приход</th>
                      <th className="px-3 py-2 text-right font-medium">Расход</th>
                      <th className="px-3 py-2 text-right font-medium">Остаток</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.points.map((p) => (
                      <tr key={p.label} className="border-b border-border last:border-0">
                        <td className="px-3 py-2">{p.label}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-success">
                          {formatRub(p.inflow)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-destructive">
                          {formatRub(p.outflow)}
                        </td>
                        <td className="px-3 py-2 text-right font-medium tabular-nums">
                          {formatRub(p.balance)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
