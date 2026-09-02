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

export default function CounterpartiesReportPage() {
  const ws = useCurrentWorkspace();
  const wsId = ws.currentId;
  const [period, setPeriod] = useState<PeriodValue>({
    mode: 'preset',
    preset: 'this-month',
  });
  const [type, setType] = useState<'INCOME' | 'EXPENSE' | 'ALL'>('ALL');

  const query = useBreakdownReport('by-counterparty', wsId, periodToQuery(period), type);

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
          <span className="pb-1">Тип</span>
          <Select
            value={type}
            onChange={(e) => setType(e.target.value as 'INCOME' | 'EXPENSE' | 'ALL')}
            className="h-9 w-[120px]"
          >
            <option value="ALL">Всё</option>
            <option value="EXPENSE">Расход</option>
            <option value="INCOME">Доход</option>
          </Select>
        </label>
        <div className="ml-auto self-end">
          <ExportButtons
            wsId={wsId}
            kind="by-counterparty"
            params={{ ...periodToQuery(period), type }}
          />
        </div>
      </FilterBar>

      <div className="space-y-4 px-6 py-4">
        {query.isLoading && <Skeleton className="h-64 w-full" />}
        {query.isError && (
          <ErrorState error={query.error} onRetry={() => query.refetch()} />
        )}

        {query.data && query.data.rows.length === 0 && (
          <Card>
            <EmptyState
              icon={BarChart3}
              title="Нет операций за период"
              hint="Поменяйте период или тип — либо добавьте операции."
            />
          </Card>
        )}

        {query.data && query.data.rows.length > 0 && (
          <Card className="overflow-x-auto !p-0">
            <table className="w-full text-base">
              <thead className="border-b border-border">
                <tr className="text-left text-xs uppercase text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Контрагент</th>
                  <th className="px-4 py-2 text-right font-medium">Операций</th>
                  <th className="px-4 py-2 text-right font-medium">Доход</th>
                  <th className="px-4 py-2 text-right font-medium">Расход</th>
                  <th className="px-4 py-2 text-right font-medium">Итого</th>
                </tr>
              </thead>
              <tbody>
                {query.data.rows.map((r) => (
                  <tr key={r.id ?? 'none'} className="border-b border-border last:border-0">
                    <td className="px-4 py-2">
                      {r.id !== null ? (
                        <Link
                          href={
                            txDrilldownHref({
                              counterpartyId: r.id,
                              from: query.data!.period.from,
                              to: query.data!.period.to,
                              type: type === 'ALL' ? undefined : type,
                            }) as Parameters<typeof Link>[0]['href']
                          }
                          className="cursor-pointer hover:text-foreground hover:underline"
                        >
                          {r.name}
                        </Link>
                      ) : (
                        r.name
                      )}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{r.count}</td>
                    <td className="px-4 py-2 text-right text-success"><Money value={r.income} tone="plain" /></td>
                    <td className="px-4 py-2 text-right text-destructive"><Money value={r.expense} tone="plain" /></td>
                    <td className="px-4 py-2 text-right font-medium"><Money value={r.total} /></td>
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
