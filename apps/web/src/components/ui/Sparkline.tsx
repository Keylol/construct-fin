import { useId } from 'react';
import { cn } from '@/lib/cn';

/**
 * Мини-тренд для KPI-плиток (решение №24 блица): самописный SVG по готовым
 * данным отчёта, без библиотек. Значения — числа только для ГЕОМЕТРИИ
 * (нормализация высот); деньги наружу не выводит.
 */
export function Sparkline({
  values,
  className,
}: {
  values: number[];
  className?: string;
}) {
  const gradId = useId();
  if (values.length < 2) return null;

  const w = 100;
  const h = 28;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = w / (values.length - 1);
  const pts = values.map((v, i) => {
    const x = i * step;
    // 2px отступ сверху/снизу, чтобы линия не резалась на экстремумах.
    const y = h - 2 - ((v - min) / span) * (h - 4);
    return [x, y] as const;
  });
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `0,${h} ${line} ${w},${h}`;

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      aria-hidden
      className={cn('h-7 w-full', className)}
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.18" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={area} fill={`url(#${gradId})`} />
      <polyline
        points={line}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
