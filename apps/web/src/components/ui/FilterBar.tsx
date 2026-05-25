import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export function FilterBar({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-end gap-3 border-b border-border bg-background px-6 py-3',
        className,
      )}
      {...props}
    />
  );
}
