'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';
import { NAV_GROUPS } from './nav-items';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';

interface SidebarProps {
  /** Called after a nav link is clicked — mobile drawer uses this to close. */
  onNavigate?: () => void;
  /**
   * rail — узкая рейка 64px с расхлопом по hover (десктоп, решение №17 блица:
   * +176px рабочей области). full — полный сайдбар 240px (мобильный drawer).
   */
  variant?: 'full' | 'rail';
}

export function Sidebar({ onNavigate, variant = 'full' }: SidebarProps) {
  const pathname = usePathname();

  if (variant === 'rail') {
    return <RailSidebar pathname={pathname} />;
  }

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
                {group.items.map((item) => (
                  <NavLink
                    key={item.href}
                    item={item}
                    pathname={pathname}
                    onNavigate={onNavigate}
                  />
                ))}
              </ul>
            </div>
          );
        })}
      </nav>
    </aside>
  );
}

/**
 * Рейка 64px: иконки на месте, подписи проявляются при наведении.
 * Анимируется ТОЛЬКО ширина окна-обтравки (overflow-hidden); контент внутри —
 * всегда фиксированные 240px, поэтому при расхлопе ничего не переносится,
 * не прыгает и не наезжает друг на друга (фикс «шторки» 07-13).
 */
function RailSidebar({ pathname }: { pathname: string | null }) {
  return (
    <aside className="group/rail relative z-40 h-full w-16 shrink-0">
      <div
        className={cn(
          'absolute inset-y-0 left-0 w-16 overflow-hidden border-r border-border bg-card',
          'transition-[width,box-shadow] duration-200 ease-out',
          'group-hover/rail:w-60 group-hover/rail:shadow-lg group-focus-within/rail:w-60',
          'motion-reduce:transition-none',
        )}
      >
        {/* Внутренняя колонка фиксированной конечной ширины */}
        <div className="flex h-full w-60 flex-col">
          {/* Brand: иконка на фиксированном x, подпись проявляется */}
          <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-border px-[18px]">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary text-sm font-semibold text-primary-foreground">
              C
            </div>
            <RailLabel className="text-sm font-semibold tracking-tight">Construct</RailLabel>
          </div>

          {/* Переключатель пространства: всегда в DOM (высота стабильна),
              в свёрнутом виде — невидим и недоступен для клика/фокуса. */}
          <div
            className={cn(
              'shrink-0 border-b border-border px-3 py-3',
              'pointer-events-none opacity-0 transition-opacity duration-150',
              'group-hover/rail:pointer-events-auto group-hover/rail:opacity-100',
              'group-focus-within/rail:pointer-events-auto group-focus-within/rail:opacity-100',
              'motion-reduce:transition-none',
            )}
          >
            <WorkspaceSwitcher />
          </div>

          <nav className="flex-1 overflow-y-auto px-3 py-3">
            {NAV_GROUPS.map((group, gi) => {
              const isFirst = gi === 0;
              return (
                <div
                  key={`${group.label ?? 'main'}-${gi}`}
                  className={cn(!isFirst && 'mt-3 border-t border-border pt-3')}
                >
                  {group.label && (
                    <div className="h-5 px-2 pb-1.5">
                      <RailLabel className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        {group.label}
                      </RailLabel>
                    </div>
                  )}
                  <ul className="space-y-0.5">
                    {group.items.map((item) => (
                      <NavLink key={item.href} item={item} pathname={pathname} rail />
                    ))}
                  </ul>
                </div>
              );
            })}
          </nav>
        </div>
      </div>
    </aside>
  );
}

function RailLabel({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        'whitespace-nowrap opacity-0 transition-opacity duration-150',
        'group-hover/rail:opacity-100 group-focus-within/rail:opacity-100',
        'motion-reduce:transition-none',
        className,
      )}
    >
      {children}
    </span>
  );
}

function NavLink({
  item,
  pathname,
  onNavigate,
  rail,
}: {
  item: (typeof NAV_GROUPS)[number]['items'][number];
  pathname: string | null;
  onNavigate?: () => void;
  rail?: boolean;
}) {
  // Active rule: exact match OR child route (with trailing slash boundary)
  // — except /reports must not light up for /reports/rules.
  const exact = pathname === item.href;
  const child =
    pathname?.startsWith(item.href + '/') &&
    // «Отчёты» не подсвечиваются только на /reports/rules — у правил свой пункт.
    !(item.href === '/reports' && pathname?.startsWith('/reports/rules'));
  const active = exact || child;
  const Icon = item.icon;
  return (
    <li>
      <Link
        href={item.href as Parameters<typeof Link>[0]['href']}
        onClick={onNavigate}
        title={rail ? item.label : undefined}
        className={cn(
          'relative flex h-8 items-center gap-2.5 rounded-sm px-2 text-sm transition-colors',
          active
            ? 'bg-accent font-medium text-primary before:absolute before:inset-y-1.5 before:-left-2 before:w-0.5 before:rounded-r before:bg-primary'
            : 'text-foreground/75 hover:bg-secondary hover:text-foreground',
        )}
      >
        <Icon
          className={cn('h-4 w-4 shrink-0', active ? 'text-primary' : 'text-muted-foreground')}
          aria-hidden
        />
        {rail ? (
          <RailLabel className="truncate">{item.label}</RailLabel>
        ) : (
          <span className="truncate">{item.label}</span>
        )}
      </Link>
    </li>
  );
}
