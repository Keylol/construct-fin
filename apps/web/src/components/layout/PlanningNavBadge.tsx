'use client';

import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { usePlanningCount } from '@/hooks/usePlanning';
import { CountBadge } from '@/components/ui/CountBadge';

/**
 * «Горящие» платежи (просрочка + скоро по leadDays) — на пункте навигации.
 * Самодостаточен: сам тянет счётчик. В рейке — точка, в меню — число.
 */
export function PlanningNavBadge({ collapsed }: { collapsed?: boolean }) {
  const { current } = useCurrentWorkspace();
  const count = usePlanningCount(current?.id ?? null);
  const n = count.data?.count ?? 0;
  return (
    <CountBadge
      count={n}
      tone="destructive"
      dot={collapsed}
      label={`${n} к оплате`}
      className={collapsed ? 'absolute right-1 top-1' : 'ml-auto'}
    />
  );
}
