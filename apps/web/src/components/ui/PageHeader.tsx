import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

// Хлебные крошки рендерятся ГЛОБАЛЬНО в верхнем баре (components/layout/Header)
// из URL — единый источник; у страничного заголовка своего дубля нет.
interface PageHeaderProps {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function PageHeader({
  title,
  description,
  actions,
  className,
}: PageHeaderProps) {
  return (
    <div
      className={cn(
        'flex flex-col gap-3 border-b border-border bg-background px-6 py-5',
        'sm:flex-row sm:items-end sm:justify-between sm:gap-6',
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <h1 className="text-xl font-semibold leading-tight tracking-tight sm:text-2xl">
          {title}
        </h1>
        {description && (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && (
        <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">{actions}</div>
      )}
    </div>
  );
}
