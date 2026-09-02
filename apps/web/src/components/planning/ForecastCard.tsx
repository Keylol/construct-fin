'use client';

import { useMemo, useState } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatRub } from '@construct/shared';
import { Card } from '@/components/ui/Card';
import { Money } from '@/components/ui/Money';
import { Select } from '@/components/ui/Select';
import { PeriodField } from '@/components/reports/PeriodPicker';
import { Skeleton } from '@/components/ui/Skeleton';
import { useForecast } from '@/hooks/usePlanning';
import { formatDate } from '@/lib/dates';
import { cn } from '@/lib/cn';

/**
 * Прогноз остатка на горизонте платёжного календаря. Две траектории:
 * «с ожидаемыми оплатами» (плановые оттоки + будущие оплаты по графикам
 * заказов) и «только оттоки» (пессимистичная). Первый день в минусе —
 * предупреждение о кассовом разрыве заранее.
 */
export function ForecastCard({ wsId }: { wsId: string }) {
  const [days, setDays] = useState(60);
  const query = useForecast(wsId, days);

  const f = query.data;
  const chartData = useMemo(
    () =>
      (f?.points ?? []).map((p) => ({
        label: formatDate(p.date),
        balance: Number(p.balance),
        balanceOut: Number(p.balanceOut),
      })),
    [f],
  );

  const gap = f?.firstGapIn ?? null;
  const gapPessimistic = f?.firstGapOut ?? null;

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-foreground">Прогноз остатка</h2>
        {/* Здесь период смотрит ВПЕРЁД — это горизонт прогноза, а не «период
            назад» из отчётов. Оболочка та же, набор значений свой. */}
        <PeriodField label="Горизонт">
          <Select
            value={String(days)}
            onChange={(e) => setDays(Number(e.target.value))}
            className="h-9 w-[170px]"
          >
            <option value="30">30 дней</option>
            <option value="60">60 дней</option>
            <option value="90">90 дней</option>
            <option value="180">180 дней</option>
          </Select>
        </PeriodField>
      </div>

      {query.isLoading || !f ? (
        <Skeleton className="h-64" />
      ) : (
        <Card className="space-y-3 !p-4">
          {/* Предупреждение о разрыве */}
          {gap ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
              <b>Кассовый разрыв {formatDate(gap)}</b> — с учётом ожидаемых оплат остаток
              уходит в минус. Перенесите платежи или ускорьте поступления.
            </div>
          ) : gapPessimistic ? (
            <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
              Без ожидаемых оплат клиентов остаток уйдёт в минус{' '}
              <b>{formatDate(gapPessimistic)}</b> — прогноз держится на поступлениях по
              графикам заказов ({formatRub(f.totals.in)}).
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              На горизонте {f.horizonDays} дней остаток в минус не уходит: старт{' '}
              <b className="num text-foreground"><Money value={f.opening} /></b>, оттоки{' '}
              {formatRub(f.totals.out)}, ожидаемые поступления {formatRub(f.totals.in)}.
            </p>
          )}

          <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 6, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis
                  dataKey="label"
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={11}
                  minTickGap={28}
                />
                <YAxis
                  tickFormatter={(v) => new Intl.NumberFormat('ru-RU').format(Number(v))}
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={11}
                  width={72}
                />
                <Tooltip
                  formatter={(v, name) => [
                    formatRub(Number(v)),
                    name === 'balance' ? 'С ожидаемыми оплатами' : 'Только оттоки',
                  ]}
                  contentStyle={{
                    borderRadius: 6,
                    border: '1px solid hsl(var(--border))',
                    background: 'hsl(var(--card))',
                    fontSize: 12,
                  }}
                />
                <Legend
                  verticalAlign="top"
                  wrapperStyle={{ fontSize: 12 }}
                  formatter={(value) =>
                    value === 'balance' ? 'С ожидаемыми оплатами' : 'Только оттоки'
                  }
                />
                {/* Нулевая линия — граница кассового разрыва. */}
                <ReferenceLine y={0} stroke="hsl(var(--destructive))" strokeDasharray="4 4" />
                <Line
                  type="monotone"
                  dataKey="balance"
                  stroke="hsl(var(--primary))"
                  strokeWidth={2}
                  dot={false}
                />
                <Line
                  type="monotone"
                  dataKey="balanceOut"
                  stroke="hsl(var(--muted-foreground))"
                  strokeWidth={1.5}
                  strokeDasharray="6 4"
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {Number(f.overdueExpectedIn) > 0 && (
            <p className={cn('text-xs text-muted-foreground')}>
              Просроченные ожидания от клиентов {formatRub(f.overdueExpectedIn)} в прогноз не
              включены — на них нельзя опираться, работайте с дебиторской задолженностью.
            </p>
          )}
        </Card>
      )}
    </section>
  );
}
