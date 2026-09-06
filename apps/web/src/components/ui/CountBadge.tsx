import { cn } from '@/lib/cn';

type Tone = 'warning' | 'destructive' | 'primary' | 'muted';

const PILL: Record<Tone, string> = {
  warning: 'bg-warning/15 text-warning',
  destructive: 'bg-destructive/15 text-destructive',
  primary: 'bg-accent text-primary',
  muted: 'bg-muted text-muted-foreground',
};

const DOT: Record<Tone, string> = {
  warning: 'bg-warning',
  destructive: 'bg-destructive',
  primary: 'bg-primary',
  muted: 'bg-muted-foreground',
};

/**
 * Счётчик на пункте меню, вкладке или чипе шапки: «242» строк на разборе,
 * «3» платежа к оплате. Число всегда точное (решение после #172: по нему
 * человек решает, сколько работы осталось). `dot` — точка вместо числа там,
 * где числу нет места (свёрнутая рейка), позиционируется вызывающим.
 * Ноль не рисуется: отсутствие бейджа и есть «всё сделано».
 */
export function CountBadge({
  count,
  tone = 'warning',
  dot,
  label,
  className,
}: {
  count: number;
  tone?: Tone;
  dot?: boolean;
  /** Подпись для читалки: «242 на обработку». */
  label?: string;
  className?: string;
}) {
  if (count <= 0) return null;
  if (dot) {
    return (
      <span
        aria-label={label}
        className={cn('h-2 w-2 rounded-full ring-2 ring-card', DOT[tone], className)}
      />
    );
  }
  return (
    <span
      aria-label={label}
      className={cn(
        'inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5',
        'text-[11px] font-semibold leading-none tabular-nums',
        PILL[tone],
        className,
      )}
    >
      {count}
    </span>
  );
}
