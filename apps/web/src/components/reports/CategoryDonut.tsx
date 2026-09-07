'use client';

import { useMemo } from 'react';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { D, add, formatRub, toMoneyString } from '@construct/shared';
import { Card } from '@/components/ui/Card';
import { Money } from '@/components/ui/Money';
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
  /** Для recharts — число; показ и суммы идут по `amount`. */
  value: number;
  amount: string;
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
  const sorted = [...rows].sort((a, b) => D(b.total).comparedTo(D(a.total)));
  const top = sorted.slice(0, CHART_CATEGORICAL.length);
  const rest = sorted.slice(CHART_CATEGORICAL.length);
  const slices: DonutSlice[] = top.map((r, i) => ({
    key: donutKey(r),
    name: r.name,
    value: Number(r.total),
    amount: r.total,
    share: r.share,
    color: CHART_CATEGORICAL[i]!,
  }));
  if (rest.length > 0) {
    // Сумма «Прочего» — Decimal, как любые деньги; float только для recharts.
    const amount = toMoneyString(rest.reduce((acc, r) => add(acc, r.total), D(0)));
    const share = rest.reduce((acc, r) => acc + r.share, 0);
    slices.push({
      key: '__other__',
      name: `Прочее (${rest.length})`,
      value: Number(amount),
      amount,
      share,
      color: CHART_OTHER,
    });
  }
  return slices.filter((s) => D(s.amount).gt(0));
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
  const total = useMemo(
    () => toMoneyString(slices.reduce((acc, s) => add(acc, s.amount), D(0))),
    [slices],
  );
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
                formatter={(_v, name, entry) => {
                  const slice = entry?.payload as DonutSlice | undefined;
                  return [
                    `${formatRub(slice?.amount ?? '0')} · ${((slice?.share ?? 0) * 100).toFixed(1)}%`,
                    String(name),
                  ];
                }}
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
            <Money value={total} className="max-w-[7.5rem] text-center text-base font-semibold leading-tight" />
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
              <Money value={s.amount} className="w-[110px] shrink-0 text-right" />
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}
