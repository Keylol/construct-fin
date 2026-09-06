'use client';

import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useInboxCount } from '@/hooks/useInbox';
import { CountBadge } from '@/components/ui/CountBadge';

/**
 * Строки «Входящих» на разборе — на пункте навигации. Самодостаточен: сам
 * тянет счётчик (кэш + refetch раз в минуту). В свёрнутой рейке — точка на
 * иконке, в развёрнутом меню — число.
 */
export function InboxNavBadge({ collapsed }: { collapsed?: boolean }) {
  const { current } = useCurrentWorkspace();
  const count = useInboxCount(current?.id ?? null);
  const n = count.data?.count ?? 0;
  return (
    <CountBadge
      count={n}
      tone="warning"
      dot={collapsed}
      label={`${n} на обработку`}
      className={collapsed ? 'absolute right-1 top-1' : 'ml-auto'}
    />
  );
}
