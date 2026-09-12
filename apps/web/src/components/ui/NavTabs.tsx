'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { TAB_ACTIVE_CLASS, TAB_CLASS, TAB_LIST_CLASS } from '@/components/ui/Tabs';
import { cn } from '@/lib/cn';

export interface NavTab {
  href: string;
  label: string;
}

/**
 * Вкладки-ссылки: разделы отчётов. Тот же вид, что у `Tabs` внутри окна и
 * «Входящих», но каждая вкладка — адрес (F5, «назад», ссылка коллеге).
 * Активна вкладка с точным совпадением пути.
 */
export function NavTabs({
  items,
  ariaLabel,
  className,
}: {
  items: NavTab[];
  ariaLabel: string;
  className?: string;
}) {
  const pathname = usePathname();
  return (
    <nav aria-label={ariaLabel} className={cn('border-b border-border bg-background', className)}>
      <ul className={cn(TAB_LIST_CLASS, 'flex h-auto min-h-10 w-full flex-wrap border-0 px-6')}>
        {items.map((t) => {
          const active = pathname === t.href;
          return (
            <li key={t.href}>
              <Link
                href={t.href as Parameters<typeof Link>[0]['href']}
                aria-current={active ? 'page' : undefined}
                className={cn(TAB_CLASS, active && TAB_ACTIVE_CLASS)}
              >
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
