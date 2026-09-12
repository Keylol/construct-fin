import type { ReactNode } from 'react';
import { X } from '@/components/ui/icons';
import { cn } from '@/lib/cn';

/**
 * Чип фильтра, который приходит извне (drill-down из отчёта, переход с плитки
 * клиента): своего контрола у него нет, значение можно только увидеть и снять.
 * Весь чип — одна кнопка «снять», крестик лишь подсказывает. Высота — как у
 * полей полосы фильтров.
 */
export function Chip({
  label,
  onRemove,
  title,
  className,
}: {
  label: ReactNode;
  onRemove: () => void;
  title?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onRemove}
      title={title}
      className={cn(
        'flex h-9 items-center gap-1.5 rounded-sm border border-input bg-secondary px-2.5 text-sm text-foreground',
        'transition-colors hover:bg-secondary/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
    >
      {label}
      <X className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
    </button>
  );
}
