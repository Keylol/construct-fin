'use client';

import { useMemo } from 'react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatRub } from '@construct/shared';
import { SectionCard } from '@/components/ui/SectionCard';
import { CHART_SEMANTIC } from '@/lib/chart';
import { MONTH_NAMES } from '@/lib/labels';

/**
 * Единственный график отчётов (решение 10.09: вместо водопада, кольца, топ-10
 * и стека давности): столбцы прихода и расхода по периодам и одна линия
 * итога поверх — прибыль в ОПиУ, остаток денег в ОДДС. Одна ось (всё в
 * рублях), никаких серий сравнения — «± к прошлому периоду» живёт в плитках.
 * Суммы приходят строками (Decimal), в числа переводятся только для recharts.
 */
export interface FlowPoint {
  /** Ключ периода из API: `YYYY-MM` или `YYYY-Qn`. */
  label: string;
  income: string;
  expense: string;
  line: string;
}

const MONTH_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

/** Подпись оси: `2026-01` → «янв 26», `2026-Q1` → «1 кв 26». */
export function shortPeriodLabel(label: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(label);
  if (m) return `${MONTH_SHORT[Number(m[2]) - 1] ?? m[2]} ${m[1]!.slice(2)}`;
  const q = /^(\d{4})-Q(\d)$/.exec(label);
  if (q) return `${q[2]} кв ${q[1]!.slice(2)}`;
  return label;
}

/** Подпись в подсказке: «Январь 2026», «1 квартал 2026». */
export function longPeriodLabel(label: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(label);
  if (m) return `${MONTH_NAMES[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
  const q = /^(\d{4})-Q(\d)$/.exec(label);
  if (q) return `${q[2]} квартал ${q[1]}`;
  return label;
}

const compact = new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 });

function LegendSwatch({ kind, color }: { kind: 'bar' | 'line'; color: string }) {
  return kind === 'bar' ? (
    <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-[2px]" style={{ background: color }} />
  ) : (
    <span aria-hidden className="h-0.5 w-3.5 shrink-0 rounded-full" style={{ background: color }} />
  );
}

export function FlowChart({
  points,
  title,
  incomeLabel,
  expenseLabel,
  lineLabel,
  caption,
}: {
  points: FlowPoint[];
  title: string;
  incomeLabel: string;
  expenseLabel: string;
  lineLabel: string;
  /** Пояснение справа от заголовка: базис или период. */
  caption?: string;
}) {
  const data = useMemo(
    () =>
      points.map((p) => ({
        label: p.label,
        income: Number(p.income),
        expense: Number(p.expense),
        line: Number(p.line),
      })),
    [points],
  );
  if (data.length === 0) return null;

  const series = [
    { key: 'income', label: incomeLabel, color: CHART_SEMANTIC.income, kind: 'bar' as const },
    { key: 'expense', label: expenseLabel, color: CHART_SEMANTIC.expense, kind: 'bar' as const },
    { key: 'line', label: lineLabel, color: CHART_SEMANTIC.total, kind: 'line' as const },
  ];

  return (
    <SectionCard
      title={
        <>
          {title}
          {caption && <span className="ml-2 font-normal text-muted-foreground">{caption}</span>}
        </>
      }
      aside={
        // Легенда — текстом в токенах текста, цвет несёт только метка.
        <ul className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {series.map((s) => (
            <li key={s.key} className="flex items-center gap-1.5">
              <LegendSwatch kind={s.kind} color={s.color} />
              {s.label}
            </li>
          ))}
        </ul>
      }
    >
      <div className="h-72 w-full px-2 pb-2 pt-3">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 12, left: 4, bottom: 0 }} barGap={2} barCategoryGap="28%">
            <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
            <XAxis
              dataKey="label"
              tickFormatter={shortPeriodLabel}
              tickLine={false}
              axisLine={false}
              stroke="hsl(var(--muted-foreground))"
              fontSize={12}
              dy={6}
            />
            <YAxis
              tickFormatter={(v) => compact.format(Number(v))}
              tickLine={false}
              axisLine={false}
              width={56}
              stroke="hsl(var(--muted-foreground))"
              fontSize={12}
            />
            <Tooltip
              cursor={{ fill: 'hsl(var(--secondary))' }}
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const row = payload[0]?.payload as (typeof data)[number] | undefined;
                if (!row) return null;
                return (
                  <div className="rounded-md border border-border bg-card px-3 py-2 text-xs shadow-md">
                    <div className="mb-1 font-medium text-foreground">{longPeriodLabel(String(label))}</div>
                    {series.map((s) => (
                      <div key={s.key} className="flex items-center justify-between gap-4 py-0.5 text-muted-foreground">
                        <span className="flex items-center gap-1.5">
                          <LegendSwatch kind={s.kind} color={s.color} />
                          {s.label}
                        </span>
                        <span className="num text-foreground">{formatRub(row[s.key as keyof typeof row] as number)}</span>
                      </div>
                    ))}
                  </div>
                );
              }}
            />
            {/* Без анимации: столбцы появляются сразу (и не пропадают в headless — грабли #117). */}
            <Bar
              dataKey="income"
              fill={CHART_SEMANTIC.income}
              radius={[4, 4, 0, 0]}
              maxBarSize={28}
              isAnimationActive={false}
            />
            <Bar
              dataKey="expense"
              fill={CHART_SEMANTIC.expense}
              radius={[4, 4, 0, 0]}
              maxBarSize={28}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="line"
              stroke={CHART_SEMANTIC.total}
              strokeWidth={2}
              dot={{ r: 3, strokeWidth: 2, fill: 'hsl(var(--card))' }}
              activeDot={{ r: 4 }}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </SectionCard>
  );
}
