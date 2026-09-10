import type { HTMLAttributes, ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { RotateCcw } from '@/components/ui/icons';
import { cn } from '@/lib/cn';

export function FilterBar({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        // sunken-поверхность (решение №16): зона фильтров «утоплена» относительно
        // фона — глубина без теней, белые поля читаются «окнами».
        'flex flex-wrap items-end gap-3 border-b border-border bg-sunken px-6 py-3',
        className,
      )}
      {...props}
    />
  );
}

/**
 * «Сброс» полосы фильтров — всегда последним, одной высоты с полями (h-9):
 * до этого кнопка была на 4px ниже полей и «проваливалась» при переносе строк.
 * Один компонент на 16 экранов вместо копий из четырёх строк.
 */
export function FilterReset({
  onClick,
  className,
  children = 'Сброс',
}: {
  onClick: () => void;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="md"
      onClick={onClick}
      className={cn('self-end px-3 text-muted-foreground hover:text-foreground', className)}
    >
      <RotateCcw className="h-3.5 w-3.5" />
      {children}
    </Button>
  );
}
