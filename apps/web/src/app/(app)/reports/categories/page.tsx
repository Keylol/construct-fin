'use client';

import { useState } from 'react';
import Link from 'next/link';
import { BarChart3 } from '@/components/ui/icons';
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
import { txDrilldownHref } from '@/lib/tx-filters';

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

  const rows = query.data?.rows ?? [];

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

        {query.data && rows.length === 0 && (
          <Card>
            <EmptyState
              icon={BarChart3}
              title="Нет операций за период"
              hint="Поменяйте период или тип — либо добавьте операции."
            />
          </Card>
        )}

        {/* Доля — полосой прямо в строке (гроссбух-стиль вместо круговой
            диаграммы: подписи не наезжают, мелкие категории читаются). */}
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
                    <td className="num px-4 py-2.5 text-right font-medium">
                      {formatRub(r.total)}
                    </td>
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
