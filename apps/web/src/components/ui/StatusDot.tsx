import { cn } from '@/lib/cn';

type Tone = 'success' | 'warning' | 'destructive' | 'muted' | 'primary';

const DOT: Record<Tone, string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  destructive: 'bg-destructive',
  muted: 'bg-muted-foreground/50',
  primary: 'bg-primary',
};

/**
 * Статус в таблицах (решение №15 блица): семантическая точка + текст вместо
 * цветной пилюли — строка читается по цифрам, статус — вторичный сигнал.
 * Точка НЕ декоративная: цвет кодирует состояние (скилл-исключение).
 */
export function StatusDot({
  tone,
  label,
  className,
}: {
  tone: Tone;
  label: string;
  className?: string;
}) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-sm', className)}>
      <span aria-hidden className={cn('h-1.5 w-1.5 shrink-0 rounded-full', DOT[tone])} />
      <span className="text-foreground/80">{label}</span>
    </span>
  );
}
