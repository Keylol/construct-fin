'use client';

import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useCrmWaitingCount } from '@/hooks/useCrm';
import { CountBadge } from '@/components/ui/CountBadge';

/**
 * Сделки amoCRM, ждущие заказа в учёте, — на пункте навигации. Тот же вид и
 * тон, что у «Входящих»: очередь работы видна из любого экрана, а не только
 * когда человек сам зашёл в раздел.
 */
export function CrmNavBadge({ collapsed }: { collapsed?: boolean }) {
  const { current } = useCurrentWorkspace();
  const count = useCrmWaitingCount(current?.id ?? null);
  const n = count.data?.count ?? 0;
  return (
    <CountBadge
      count={n}
      tone="warning"
      dot={collapsed}
      label={`${n} сделок ждут заказа`}
      className={collapsed ? 'absolute right-1 top-1' : 'ml-auto'}
    />
  );
}
