'use client';

import { useMemo } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatRub } from '@construct/shared';
import { Card } from '@/components/ui/Card';
import { CHART_SEMANTIC } from '@/lib/chart';

/**
 * Топ-10 по валовой прибыли — горизонтальные бары. Величина одной меры →
 * ОДИН цвет (не категориальная радуга); убыточные позиции — красным
 * (полярность), имена — прямыми подписями слева.
 */

export interface MarginBarRow {
  name: string;
  margin: number;
}

export function MarginTopBar({
  rows,
  title,
}: {
  rows: { name: string; margin: string }[];
  title: string;
}) {
  const data = useMemo<MarginBarRow[]>(
    () =>
      [...rows]
        .map((r) => ({ name: r.name, margin: Number(r.margin) }))
        .sort((a, b) => b.margin - a.margin)
        .slice(0, 10),
    [rows],
  );
  if (data.length < 2) return null;

  const height = Math.max(180, data.length * 34 + 40);

  return (
    <Card className="!p-3">
      <div className="px-1 pb-1 text-sm font-medium">{title}</div>
      <div style={{ height }} className="w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data}
            layout="vertical"
            margin={{ top: 4, right: 16, left: 8, bottom: 0 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
            <XAxis
              type="number"
              tickFormatter={(v) =>
                new Intl.NumberFormat('ru-RU', { notation: 'compact' }).format(Number(v))
              }
              stroke="hsl(var(--muted-foreground))"
              fontSize={11}
            />
            <YAxis
              type="category"
              dataKey="name"
              width={160}
              stroke="hsl(var(--muted-foreground))"
              fontSize={12}
              tickFormatter={(v: string) => (v.length > 20 ? `${v.slice(0, 19)}…` : v)}
            />
            <Tooltip
              formatter={(v) => [formatRub(Number(v).toFixed(2)), 'Валовая прибыль']}
              contentStyle={{
                borderRadius: 6,
                border: '1px solid hsl(var(--border))',
                background: 'hsl(var(--card))',
                fontSize: 12,
              }}
            />
            <Bar dataKey="margin" radius={[0, 3, 3, 0]} barSize={18} isAnimationActive={false}>
              {data.map((d) => (
                <Cell
                  key={d.name}
                  fill={d.margin >= 0 ? 'hsl(var(--primary))' : CHART_SEMANTIC.expense}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}
