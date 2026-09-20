'use client';

import { useMemo } from 'react';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { formatRub } from '@construct/shared';
import { SectionCard } from '@/components/ui/SectionCard';
import { CHART_CATEGORICAL, CHART_OTHER } from '@/lib/chart';

/**
 * Кольцо долей для разреза «По категориям»: на что уходят деньги за период.
 * Таблица под ним отвечает «сколько» с точностью до копейки, кольцо — «какая
 * часть» одним взглядом, чего колонка «Доля» не даёт: три десятка строк с
 * процентами глазом не складываются.
 *
 * Оформление то же, что у FlowChart в ОПиУ: SectionCard с заголовком и
 * легендой справа, тот же тултип и те же токены. Палитра CHART_CATEGORICAL —
 * семь фиксированных слотов, всё сверх них сворачивается в «Прочее» серым.
 * Цвет здесь следует за рангом строки, а не за сущностью: состав разреза в
 * каждом периоде свой. Анимация выключена, как в FlowChart, иначе кольцо не
 * появляется в headless-проверках (грабли #117).
 */
export interface SharePoint {
  /** Ключ строки: id категории либо null для «Без категории». */
  id: string | null;
  name: string;
  /** Сумма строкой (Decimal) — в число переводим только для recharts. */
  total: string;
}

/** Сколько строк показываем отдельными цветами; остальное — «Прочее». */
const TOP = 7;

export function ShareDonut({
  points,
  title,
  caption,
}: {
  points: SharePoint[];
  title: string;
  /** Пояснение справа от заголовка: тип разреза или период. */
  caption?: string;
}) {
  const data = useMemo(() => {
    // Возвраты могут дать по строке минус — такие в кольцо не берём: доля от
    // отрицательного числа бессмысленна. В таблице они остаются видны.
    const positive = points
      .map((p) => ({ ...p, value: Number(p.total) }))
      .filter((p) => p.value > 0)
      .sort((a, b) => b.value - a.value);
    const head = positive.slice(0, TOP);
    const tail = positive.slice(TOP);
    const rest = tail.reduce((acc, p) => acc + p.value, 0);
    const slices = head.map((p, i) => ({
      key: p.id ?? `row-${i}`,
      name: p.name,
      value: p.value,
      color: (CHART_CATEGORICAL[i] ?? CHART_OTHER) as string,
    }));
    if (rest > 0) {
      slices.push({
        key: '__rest__',
        name: `Прочее (${tail.length})`,
        value: rest,
        color: CHART_OTHER as string,
      });
    }
    const sum = slices.reduce((acc, s) => acc + s.value, 0);
    return { slices, sum };
  }, [points]);

  if (data.slices.length === 0 || data.sum <= 0) return null;

  const share = (v: number) => `${((v / data.sum) * 100).toFixed(1)}%`;

  return (
    <SectionCard
      title={
        <>
          {title}
          {caption && <span className="ml-2 font-normal text-muted-foreground">{caption}</span>}
        </>
      }
      aside={
        <ul className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {data.slices.map((s) => (
            <li key={s.key} className="flex items-center gap-1.5">
              <span
                aria-hidden
                className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                style={{ background: s.color }}
              />
              <span className="max-w-[160px] truncate">{s.name}</span>
              <span className="num text-muted-foreground">{share(s.value)}</span>
            </li>
          ))}
        </ul>
      }
    >
      <div className="h-72 w-full px-2 pb-2 pt-3">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data.slices}
              dataKey="value"
              nameKey="name"
              cx="50%"
              cy="50%"
              innerRadius="55%"
              outerRadius="85%"
              paddingAngle={1}
              stroke="hsl(var(--card))"
              strokeWidth={2}
              isAnimationActive={false}
            >
              {data.slices.map((s) => (
                <Cell key={s.key} fill={s.color} />
              ))}
            </Pie>
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const row = payload[0]?.payload as (typeof data.slices)[number] | undefined;
                if (!row) return null;
                return (
                  <div className="rounded-md border border-border bg-card px-3 py-2 text-xs shadow-md">
                    <div className="mb-1 flex items-center gap-1.5 font-medium text-foreground">
                      <span
                        aria-hidden
                        className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                        style={{ background: row.color }}
                      />
                      {row.name}
                    </div>
                    <div className="flex items-center justify-between gap-4 py-0.5 text-muted-foreground">
                      <span>Сумма</span>
                      <span className="num text-foreground">{formatRub(row.value)}</span>
                    </div>
                    <div className="flex items-center justify-between gap-4 py-0.5 text-muted-foreground">
                      <span>Доля</span>
                      <span className="num text-foreground">{share(row.value)}</span>
                    </div>
                  </div>
                );
              }}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>
    </SectionCard>
  );
}
