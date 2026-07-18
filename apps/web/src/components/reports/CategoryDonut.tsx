'use client';

import { useMemo } from 'react';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { formatRub } from '@construct/shared';
import { Card } from '@/components/ui/Card';
import { CHART_CATEGORICAL, CHART_OTHER } from '@/lib/chart';
import type { BreakdownRow } from '@/lib/types';

/**
 * Структура доходов/расходов: donut топ-7 категорий + «Прочее», по центру —
 * итог периода. Цвета — категориальная палитра с ФИКСИРОВАННЫМ порядком
 * (валидирована), сегменты с 2°-зазором; идентичность дублируется легендой
 * справа (цвет не единственный носитель). Те же индексы цветов использует
 * таблица под графиком — сектор и строка узнают друг друга.
 */

export interface DonutSlice {
  key: string;
  name: string;
  value: number;
  share: number;
  color: string;
}

/**
 * Ключ строки для связки «сектор ↔ строка таблицы». Фоллбэк по имени: даже
 * если бэк отдаст две строки без id, ключи не сколлапсируют (иначе Map
 * цветов перекрасила бы строку таблицы).
 */
export function donutKey(r: Pick<BreakdownRow, 'id' | 'name'>): string {
  return r.id ?? `none:${r.name}`;
}

/** Разложить строки отчёта на топ-7 + «Прочее» с фиксированными цветами. */
export function donutSlices(rows: BreakdownRow[]): DonutSlice[] {
  const sorted = [...rows].sort((a, b) => Number(b.total) - Number(a.total));
  const top = sorted.slice(0, CHART_CATEGORICAL.length);
  const rest = sorted.slice(CHART_CATEGORICAL.length);
  const slices: DonutSlice[] = top.map((r) => ({
    key: donutKey(r),
    name: r.name,
    value: Number(r.total),
    share: r.share,
    color: CHART_CATEGORICAL[i]!,
  }));
  if (rest.length > 0) {
    const value = rest.reduce((acc, r) => acc + Number(r.total), 0);
    const share = rest.reduce((acc, r) => acc + r.share, 0);
    slices.push({ key: '__other__', name: `Прочее (${rest.length})`, value, share, color: CHART_OTHER });
  }
  return slices.filter((s) => s.value > 0);
}

export function CategoryDonut({
  rows,
  title,
  totalLabel,
}: {
  rows: BreakdownRow[];
  title: string;
  totalLabel: string;
}) {
  const slices = useMemo(() => donutSlices(rows), [rows]);
  const total = useMemo(() => slices.reduce((acc, s) => acc + s.value, 0), [slices]);
  if (slices.length === 0) return null;

  return (
    <Card className="!p-4">
      <div className="pb-2 text-sm font-medium">{title}</div>
      <div className="flex flex-wrap items-center gap-6">
        <div className="relative h-56 w-56 shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={slices}
                dataKey="value"
                nameKey="name"
                innerRadius="62%"
                outerRadius="100%"
                paddingAngle={2}
                strokeWidth={0}
                isAnimationActive={false}
              >
                {slices.map((s) => (
                  <Cell key={s.key} fill={s.color} />
                ))}
              </Pie>
              <Tooltip
                formatter={(v, name, entry) => [
                  `${formatRub(Number(v).toFixed(2))} · ${(((entry?.payload as DonutSlice)?.share ?? 0) * 100).toFixed(1)}%`,
                  String(name),
                ]}
                contentStyle={{
                  borderRadius: 6,
                  border: '1px solid hsl(var(--border))',
                  background: 'hsl(var(--card))',
                  fontSize: 12,
                }}
              />
            </PieChart>
          </ResponsiveContainer>
          {/* Hero-число в центре кольца. */}
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {totalLabel}
            </span>
            <span className="num max-w-[7.5rem] text-center text-base font-semibold leading-tight">
              {formatRub(total.toFixed(2))}
            </span>
          </div>
        </div>

        {/* Легенда: маркер + имя + доля + сумма (текст — текстовыми токенами). */}
        <ul className="min-w-[220px] flex-1 space-y-1.5">
          {slices.map((s) => (
            <li key={s.key} className="flex items-baseline gap-2 text-sm">
              <span
                className="h-2.5 w-2.5 shrink-0 translate-y-px rounded-[3px]"
                style={{ background: s.color }}
                aria-hidden
              />
              <span className="min-w-0 flex-1 truncate">{s.name}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {(s.share * 100).toFixed(1)}%
              </span>
              <span className="num w-[110px] shrink-0 text-right">{formatRub(s.value.toFixed(2))}</span>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}
