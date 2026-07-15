'use client';

import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { usePlanningCount } from '@/hooks/usePlanning';
import { cn } from '@/lib/cn';

/**
 * Бейдж «горящих» платежей (просрочка + скоро по leadDays) на пункте навигации.
 * Самодостаточен: сам тянет счётчик (кэш + refetch раз в минуту). В свёрнутой
 * рейке — точка на иконке, в развёрнутом меню — пилюля с числом. 0 → ничего.
 */
export function PlanningNavBadge({ collapsed }: { collapsed?: boolean }) {
  const { current } = useCurrentWorkspace();
  const count = usePlanningCount(current?.id ?? null);
  const n = count.data?.count ?? 0;
  if (n === 0) return null;

  if (collapsed) {
    return (
      <span
        aria-label={`${n} к оплате`}
        className="absolute right-1 top-1 h-2 w-2 rounded-full bg-destructive ring-2 ring-card"
      />
    );
  }
  return (
    <span
      className={cn(
        'ml-auto min-w-5 shrink-0 rounded-full px-1.5 text-center text-[11px] font-semibold leading-5',
        'bg-destructive/15 text-destructive',
      )}
    >
      {n > 99 ? '99+' : n}
    </span>
  );
}
