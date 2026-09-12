import type { ReactNode } from 'react';
import { Card } from '@/components/ui/Card';
import { cn } from '@/lib/cn';

/**
 * Карточка-секция: заголовок с линией снизу и содержимое вплотную к краям
 * (таблица, список строк, график). До неё каждая такая карточка собирала
 * шапку сама — семь копий с разными отступами и кеглем. `aside` — то, что
 * стоит справа от заголовка: сумма, ссылка «Все заказы», легенда графика.
 */
export function SectionCard({
  title,
  aside,
  className,
  children,
}: {
  title: ReactNode;
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Card className={cn('overflow-hidden !p-0', className)}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-border px-4 py-2.5">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {aside && <div className="flex items-center gap-3 text-xs text-muted-foreground">{aside}</div>}
      </div>
      {children}
    </Card>
  );
}
