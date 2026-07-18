'use client';

import { useMemo } from 'react';
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
import type { ReceivableClientRow } from '@/lib/types';

/**
 * Давность дебиторской задолженности по клиентам: горизонтальный стек
 * 0–30 / 30–60 / 60+ (топ-10 по сумме). Возраст долга = серьёзность, поэтому
 * шкала статусная (синий → янтарь → красный), а не категориальная; сегменты
 * с 2px-зазором (stroke поверхности), легенда обязательна.
 */

const AGE = [
  { key: '0-30', label: '0–30 дн', color: 'hsl(var(--primary) / 0.55)' },
  { key: '30-60', label: '30–60 дн', color: 'hsl(var(--warning))' },
  { key: '60+', label: '60+ дн', color: 'hsl(var(--destructive))' },
] as const;

export function AgingStack({ clients }: { clients: ReceivableClientRow[] }) {
  const data = useMemo(
    () =>
      [...clients]
        .sort((a, b) => Number(b.due) - Number(a.due))
        .slice(0, 10)
        .map((c) => ({
          name: c.clientName,
          '0-30': Number(c.buckets['0-30']),
          '30-60': Number(c.buckets['30-60']),
          '60+': Number(c.buckets['60+']),
        })),
    [clients],
  );
  if (data.length < 2) return null;

  const height = Math.max(180, data.length * 34 + 56);

  return (
    <Card className="!p-3">
      <div className="px-1 pb-1 text-sm font-medium">Давность задолженности по клиентам</div>
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
              width={150}
              stroke="hsl(var(--muted-foreground))"
              fontSize={12}
              tickFormatter={(v: string) => (v.length > 18 ? `${v.slice(0, 17)}…` : v)}
            />
            <Tooltip
              formatter={(v, name) => [formatRub(Number(v).toFixed(2)), String(name)]}
              contentStyle={{
                borderRadius: 6,
                border: '1px solid hsl(var(--border))',
                background: 'hsl(var(--card))',
                fontSize: 12,
              }}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {AGE.map((a) => (
              <Bar
                key={a.key}
                dataKey={a.key}
                name={a.label}
                stackId="age"
                fill={a.color}
                barSize={16}
                // 2px-зазор между сегментами стека — обводка цветом поверхности.
                stroke="hsl(var(--card))"
                strokeWidth={2}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}
