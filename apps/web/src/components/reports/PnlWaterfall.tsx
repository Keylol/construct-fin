'use client';

import { useMemo } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatRub } from '@construct/shared';
import { Card } from '@/components/ui/Card';
import { CHART_SEMANTIC } from '@/lib/chart';
import type { PnlBucket } from '@/lib/types';

/**
 * Водопад ОПиУ: Выручка → −Себестоимость → Валовая → −Постоянные →
 * −Переменные → −Налоги → ±Прочее → Чистая прибыль. Видно, где «утекает»
 * прибыль. Итоговые ступени (Валовая, Чистая) — брендовый navy; шаги вниз —
 * красный, шаги вверх — зелёный (семантика дохода/расхода, не категориальная).
 */

interface Step {
  name: string;
  /** Невидимое основание столбика (min(run до, run после)). */
  base: number;
  /** Видимая величина ступени (|delta| или сам итог). */
  value: number;
  /** Подпись со знаком для тултипа/лейбла. */
  signed: number;
  kind: 'up' | 'down' | 'total';
}

const COLORS: Record<Step['kind'], string> = {
  up: CHART_SEMANTIC.income,
  down: CHART_SEMANTIC.expense,
  total: 'hsl(var(--primary))',
};

function bucketNet(totals: PnlBucket, bucket: string, sign: 'income' | 'expense'): number {
  const b = totals.byBucket.find((x) => x.bucket === bucket);
  if (!b) return 0;
  const net = Number(b.income) - Number(b.expense);
  return sign === 'income' ? net : -net;
}

export function PnlWaterfall({ totals }: { totals: PnlBucket }) {
  const steps = useMemo<Step[]>(() => {
    const revenue = bucketNet(totals, 'REVENUE', 'income');
    const cogs = bucketNet(totals, 'COGS', 'expense'); // положительное число расхода
    const fixed = bucketNet(totals, 'FIXED', 'expense');
    const variable = bucketNet(totals, 'VARIABLE', 'expense');
    const tax = bucketNet(totals, 'TAX', 'expense');
    const other = bucketNet(totals, 'OTHER', 'income'); // может быть ±

    const out: Step[] = [];
    let run = 0;
    const push = (name: string, delta: number, kind: Step['kind']) => {
      if (kind === 'total') {
        out.push({ name, base: Math.min(0, delta), value: Math.abs(delta), signed: delta, kind });
        return;
      }
      const next = run + delta;
      out.push({
        name,
        base: Math.min(run, next),
        value: Math.abs(delta),
        signed: delta,
        kind,
      });
      run = next;
    };

    push('Выручка', revenue, revenue >= 0 ? 'up' : 'down');
    if (cogs !== 0) push('Себестоимость', -cogs, 'down');
    push('Валовая', run, 'total');
    if (fixed !== 0) push('Постоянные', -fixed, 'down');
    if (variable !== 0) push('Переменные', -variable, 'down');
    if (tax !== 0) push('Налоги', -tax, 'down');
    if (Math.abs(other) >= 0.01) push('Прочее', other, other >= 0 ? 'up' : 'down');
    push('Чистая', run, 'total');
    return out;
  }, [totals]);

  if (steps.every((s) => s.value === 0)) return null;

  return (
    <Card className="!p-3">
      <div className="px-1 pb-1 text-sm font-medium">Водопад прибыли</div>
      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={steps} margin={{ top: 22, right: 10, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
            <XAxis
              dataKey="name"
              stroke="hsl(var(--muted-foreground))"
              fontSize={11}
              interval={0}
            />
            <YAxis
              tickFormatter={(v) => new Intl.NumberFormat('ru-RU', { notation: 'compact' }).format(Number(v))}
              stroke="hsl(var(--muted-foreground))"
              fontSize={11}
              width={58}
            />
            <Tooltip
              formatter={(_v, _n, entry) => [
                formatRub(Math.abs((entry?.payload as Step).signed).toFixed(2)),
                (entry?.payload as Step).signed >= 0 ? 'Плюс к прибыли' : 'Минус из прибыли',
              ]}
              labelFormatter={(l) => String(l)}
              contentStyle={{
                borderRadius: 6,
                border: '1px solid hsl(var(--border))',
                background: 'hsl(var(--card))',
                fontSize: 12,
              }}
            />
            <ReferenceLine y={0} stroke="hsl(var(--border))" />
            {/* Невидимое основание, поверх — видимая ступень. */}
            <Bar dataKey="base" stackId="w" fill="transparent" isAnimationActive={false} />
            <Bar dataKey="value" stackId="w" radius={[3, 3, 0, 0]} isAnimationActive={false}>
              {steps.map((s) => (
                <Cell key={s.name} fill={COLORS[s.kind]} />
              ))}
              <LabelList
                dataKey="signed"
                position="top"
                formatter={(v: unknown) =>
                  new Intl.NumberFormat('ru-RU', { notation: 'compact' }).format(Number(v ?? 0))
                }
                style={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}
