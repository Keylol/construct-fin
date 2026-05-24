'use client';

import { useState } from 'react';
import { formatRub } from '@construct/shared';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { PeriodPicker, periodToQuery, type PeriodValue } from '@/components/reports/PeriodPicker';
import { ExportButtons } from '@/components/reports/ExportButtons';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useBreakdownReport } from '@/hooks/useReports';

export default function CounterpartiesReportPage() {
  const ws = useCurrentWorkspace();
  const wsId = ws.currentId;
  const [period, setPeriod] = useState<PeriodValue>({ mode: 'preset', preset: 'this-month' });
  const [type, setType] = useState<'INCOME' | 'EXPENSE' | 'ALL'>('ALL');

  const query = useBreakdownReport('by-counterparty', wsId, periodToQuery(period), type);

  if (!wsId) return <EmptyState title="Workspace не выбран" />;

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
              <option value="ALL">Всё</option>
              <option value="EXPENSE">Расход</option>
              <option value="INCOME">Доход</option>
            </select>
          </label>
        </div>
        {wsId && (
          <ExportButtons
            wsId={wsId}
            kind="by-counterparty"
            params={{ ...periodToQuery(period), type }}
          />
        )}
      </div>

      {query.isLoading && <p className="text-muted text-sm">Загрузка…</p>}

      {query.data && (
        <Card>
          <table className="w-full text-sm">
            <thead className="text-muted text-left text-xs uppercase">
              <tr>
                <th className="py-2">Контрагент</th>
                <th className="py-2 text-right">Транзакций</th>
                <th className="py-2 text-right">Доход</th>
                <th className="py-2 text-right">Расход</th>
                <th className="py-2 text-right">Итого</th>
              </tr>
            </thead>
            <tbody>
              {query.data.rows.map((r) => (
                <tr key={r.id ?? 'none'} className="border-t border-glass-border">
                  <td className="py-2">{r.name}</td>
                  <td className="py-2 text-right">{r.count}</td>
                  <td className="py-2 text-right text-emerald-500">{formatRub(r.income)}</td>
                  <td className="py-2 text-right text-rose-500">{formatRub(r.expense)}</td>
                  <td className="py-2 text-right font-medium">{formatRub(r.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
