import type { HTMLAttributes } from 'react';
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
