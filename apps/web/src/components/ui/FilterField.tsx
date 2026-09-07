import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * Поле полосы фильтров: подпись сверху, контрол снизу. Одно на все экраны —
 * поиск, период, счёт, категория, год в налоге, горизонт в платежах. Смысл у
 * них разный, вид обязан быть один: иначе на каждом экране заново ищешь, чем
 * тут переключают время. Раньше жило в трёх копиях (фильтры операций, отчёты,
 * inline-подписи в заказах и сверке).
 */
export function FilterField({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={cn('flex flex-col text-xs text-muted-foreground', className)}>
      <span className="pb-1">{label}</span>
      {children}
    </label>
  );
}
