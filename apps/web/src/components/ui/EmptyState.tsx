import type { ReactNode } from 'react';
import { Inbox, type LucideIcon } from '@/components/ui/icons';
import { cn } from '@/lib/cn';

interface EmptyStateProps {
  title: string;
  hint?: string;
  icon?: LucideIcon;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({
  title,
  hint,
  icon: Icon = Inbox,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center py-12 px-4',
        className,
      )}
    >
      {/* Пиктограмма 64px (решение №35 блица): крупный знак в мягком круге —
          пустой экран перестаёт быть дырой. Иконки те же (Carbon), не рисуем свои. */}
      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-sunken">
        <Icon className="h-8 w-8 text-muted-foreground/80" aria-hidden />
      </div>
      <div className="text-base font-medium text-foreground">{title}</div>
      {hint && (
        <div className="mt-1 max-w-sm text-sm text-muted-foreground">{hint}</div>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
