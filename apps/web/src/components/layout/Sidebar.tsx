'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';
import { NAV_GROUPS } from './nav-items';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';

interface SidebarProps {
  /** Called after a nav link is clicked — mobile drawer uses this to close. */
  onNavigate?: () => void;
}

export function Sidebar({ onNavigate }: SidebarProps) {
  const pathname = usePathname();

  return (
    <aside
      className={cn(
        'flex h-full w-60 shrink-0 flex-col border-r border-border bg-card',
      )}
    >
      {/* Brand */}
      <div className="flex h-14 items-center gap-2.5 border-b border-border px-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground text-sm font-semibold">
          C
        </div>
        <div className="text-sm font-semibold tracking-tight">Construct</div>
      </div>

      {/* Workspace switcher */}
      <div className="border-b border-border px-3 py-3">
        <WorkspaceSwitcher />
      </div>

      {/* Nav groups */}
      <nav className="flex-1 overflow-y-auto px-3 py-3">
        {NAV_GROUPS.map((group, gi) => {
          const isFirst = gi === 0;
          return (
            <div key={`${group.label ?? 'main'}-${gi}`} className={cn(!isFirst && 'mt-5')}>
              {group.label && (
                <div className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {group.label}
                </div>
              )}
              <ul className="space-y-0.5">
                {group.items.map((item) => {
                  // Active rule: exact match OR child route (with trailing slash boundary)
                  // — except /reports must not light up for /reports/rules.
                  const exact = pathname === item.href;
                  const child =
                    pathname?.startsWith(item.href + '/') && item.href !== '/reports';
                  const active = exact || child;
                  const Icon = item.icon;
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href as Parameters<typeof Link>[0]['href']}
                        onClick={onNavigate}
                        className={cn(
                          'relative flex h-8 items-center gap-2.5 rounded-sm px-2 text-sm transition-colors',
                          active
                            ? 'bg-accent font-medium text-primary before:absolute before:inset-y-1.5 before:-left-2 before:w-0.5 before:rounded-r before:bg-primary'
                            : 'text-foreground/75 hover:bg-secondary hover:text-foreground',
                        )}
                      >
                        <Icon
                          className={cn(
                            'h-4 w-4 shrink-0',
                            active ? 'text-primary' : 'text-muted-foreground',
                          )}
                          aria-hidden
                        />
                        <span className="truncate">{item.label}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>
    </aside>
  );
}
