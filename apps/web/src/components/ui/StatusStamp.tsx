import { cn } from '@/lib/cn';

type Tone = 'success' | 'warning' | 'destructive' | 'muted' | 'primary';

const TONE: Record<Tone, string> = {
  success: 'text-success border-success/60',
  warning: 'text-warning border-warning/60',
  destructive: 'text-destructive border-destructive/60',
  muted: 'text-muted-foreground border-muted-foreground/50',
  primary: 'text-primary border-primary/60',
};

/**
 * Статус-«штамп» для деталей документов (решение №3 блица): «ОПЛАЧЕН» как
 * оттиск печати — двойная рамка, капс, лёгкий поворот. Только в карточках
 * заказа/закупки; в таблицах остаются компактные StatusDot.
 */
export function StatusStamp({
  tone,
  label,
  className,
}: {
  tone: Tone;
  label: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-block -rotate-2 select-none rounded-[3px] border-2 px-2 py-0.5',
        'font-mono text-[11px] font-bold uppercase tracking-[0.14em]',
        'shadow-[inset_0_0_0_1px_currentColor] opacity-90',
        TONE[tone],
        className,
      )}
    >
      {label}
    </span>
  );
}
