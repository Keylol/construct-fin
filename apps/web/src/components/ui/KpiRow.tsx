import type { ReactNode } from 'react';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/lib/cn';

/**
 * Полоса KPI над списком или отчётом: сетка плиток `KpiCard`, пока данные
 * грузятся — столько же скелетонов той же высоты, чтобы экран не прыгал.
 * Число колонок — по числу плиток (до четырёх), как в «Операциях».
 */
export function KpiRow({
  loading,
  count = 3,
  className,
  children,
}: {
  loading?: boolean;
  /** Сколько плиток ожидается (для скелетонов и ширины колонок). */
  count?: 2 | 3 | 4;
  className?: string;
  children: ReactNode;
}) {
  const cols = { 2: 'sm:grid-cols-2', 3: 'sm:grid-cols-3', 4: 'sm:grid-cols-2 lg:grid-cols-4' }[count];
  return (
    <div className={cn('grid gap-3', cols, className)}>
      {loading
        ? Array.from({ length: count }).map((_, i) => <Skeleton key={i} className="h-[88px]" />)
        : children}
    </div>
  );
}
