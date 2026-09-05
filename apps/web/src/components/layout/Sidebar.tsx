'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';
import { ChevronDown, SidePanelClose, SidePanelOpen } from '@/components/ui/icons';
import { NAV_GROUPS } from './nav-items';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { InboxNavBadge } from './InboxNavBadge';
import { PlanningNavBadge } from './PlanningNavBadge';

/** Ключ состояния свёрнутой группы «Ещё» — редкое не должно мешать ежедневному. */
const MORE_OPEN_KEY = 'cf.sidebar.more';

/**
 * Раскрыта ли редкая группа. По умолчанию свёрнута, но открывается сама, если
 * человек уже находится на странице внутри неё, — иначе активный пункт был бы
 * не виден.
 */
function useGroupOpen(hrefs: string[], pathname: string | null) {
  const inside = hrefs.some((h) => pathname === h || pathname?.startsWith(h + '/'));
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (window.localStorage.getItem(MORE_OPEN_KEY) === '1') setOpen(true);
  }, []);
  const toggle = () =>
    setOpen((prev) => {
      const next = !prev;
      window.localStorage.setItem(MORE_OPEN_KEY, next ? '1' : '0');
      return next;
    });
  return { open: open || inside, toggle };
}

interface SidebarProps {
  /** Called after a nav link is clicked — mobile drawer uses this to close. */
  onNavigate?: () => void;
  /**
   * rail — десктоп: развёрнутый сайдбар 240px, сворачиваемый КЛИКОМ в рейку 64px
   * (hover-расхлоп убран 07-14: ловился в промежуточном обрезанном состоянии).
   * full — полный сайдбар 240px без кнопки сворачивания (мобильный drawer).
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
        {NAV_GROUPS.map((group, gi) => (
          <NavGroupBlock
            key={`${group.label ?? 'main'}-${gi}`}
            group={group}
            first={gi === 0}
            pathname={pathname}
            onNavigate={onNavigate}
          />
        ))}
      </nav>
    </aside>
  );
}

/**
 * Блок группы меню. Обычная группа рисуется списком; редкая («Ещё») прячется под
 * заголовок-кнопку: в рейке место дорогое, а эти экраны нужны раз в месяц.
 */
function NavGroupBlock({
  group,
  first,
  pathname,
  onNavigate,
  railCollapsed,
}: {
  group: (typeof NAV_GROUPS)[number];
  first: boolean;
  pathname: string | null;
  onNavigate?: () => void;
  railCollapsed?: boolean;
}) {
  const { open, toggle } = useGroupOpen(
    group.items.map((i) => i.href),
    pathname,
  );
  const isRail = railCollapsed !== undefined;
  const hidden = group.collapsible && !open;

  return (
    <div className={cn(!first && (isRail ? 'mt-3 border-t border-border pt-3' : 'mt-5'))}>
      {group.label &&
        (group.collapsible ? (
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            className={cn(
              'flex w-full items-center gap-1 rounded-sm px-2 py-1 text-[11px] font-semibold uppercase',
              'tracking-wide text-muted-foreground transition-colors hover:text-foreground',
              railCollapsed && 'justify-center px-0',
            )}
          >
            <ChevronDown
              className={cn(
                'h-3.5 w-3.5 shrink-0 transition-transform duration-150 motion-reduce:transition-none',
                !open && '-rotate-90',
              )}
              aria-hidden
            />
            {!railCollapsed && <span>{group.label}</span>}
          </button>
        ) : (
          <div className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {group.label}
          </div>
        ))}
      {!hidden && (
        <ul className="space-y-0.5">
          {group.items.map((item) => (
            <NavLink
              key={item.href}
              item={item}
              pathname={pathname}
              onNavigate={onNavigate}
              railCollapsed={railCollapsed}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

// Ключ сохранённого состояния «свёрнут/развёрнут» (localStorage, только десктоп).
const COLLAPSED_KEY = 'cf.sidebar.collapsed';

/**
 * Десктопный сайдбар: по умолчанию развёрнут (240px), кнопкой внизу сворачивается
 * в рейку 64px (иконки + title-подсказки). Никакого hover-расхлопа: ширина меняется
 * только по клику. Анимируется ТОЛЬКО ширина окна-обтравки (overflow-hidden);
 * контент внутри — всегда фиксированные 240px, поэтому при анимации ничего
 * не переносится и не наезжает друг на друга.
 */
function RailSidebar({ pathname }: { pathname: string | null }) {
  const [collapsed, setCollapsed] = useState(false);

  // localStorage читаем после маунта: SSR его не видит, а чтение в инициализаторе
  // дало бы hydration-рассинхрон. Возможен короткий развёрнутый кадр — приемлемо.
  useEffect(() => {
    if (window.localStorage.getItem(COLLAPSED_KEY) === '1') setCollapsed(true);
  }, []);

  const toggle = () =>
    setCollapsed((prev) => {
      const next = !prev;
      window.localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0');
      return next;
    });

  return (
    <aside
      className={cn(
        'flex h-full shrink-0 flex-col overflow-hidden border-r border-border bg-card',
        'transition-[width] duration-200 ease-out motion-reduce:transition-none',
        collapsed ? 'w-16' : 'w-60',
      )}
    >
      {/* Внутренняя колонка фиксированной конечной ширины */}
      <div className="flex h-full w-60 flex-col">
        {/* Brand: иконка на фиксированном x, подпись гаснет в свёрнутом виде */}
        <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-border px-[18px]">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary text-sm font-semibold text-primary-foreground">
            C
          </div>
          <RailLabel collapsed={collapsed} className="text-sm font-semibold tracking-tight">
            Construct
          </RailLabel>
        </div>

        {/* Переключатель пространства: всегда в DOM (высота стабильна),
            в свёрнутом виде — невидим и недоступен для клика/фокуса. */}
        <div
          aria-hidden={collapsed}
          className={cn(
            'shrink-0 border-b border-border px-3 py-3',
            'transition-opacity duration-150 motion-reduce:transition-none',
            // invisible (не только opacity-0) — выкидывает вложенные кнопки из tab-order
            collapsed && 'invisible pointer-events-none opacity-0',
          )}
        >
          <WorkspaceSwitcher />
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-3">
          {NAV_GROUPS.map((group, gi) => (
            <NavGroupBlock
              key={`${group.label ?? 'main'}-${gi}`}
              group={group}
              first={gi === 0}
              pathname={pathname}
              railCollapsed={collapsed}
            />
          ))}
        </nav>

        {/* Кнопка свернуть/развернуть — единственный способ менять ширину */}
        <div className="shrink-0 border-t border-border p-2">
          <button
            type="button"
            onClick={toggle}
            title={collapsed ? 'Развернуть меню' : 'Свернуть меню'}
            aria-expanded={!collapsed}
            className={cn(
              'flex h-8 w-full items-center gap-2.5 rounded-sm px-2 text-sm transition-colors',
              'text-muted-foreground hover:bg-secondary hover:text-foreground',
            )}
          >
            {collapsed ? (
              <SidePanelOpen className="h-4 w-4 shrink-0" aria-hidden />
            ) : (
              <SidePanelClose className="h-4 w-4 shrink-0" aria-hidden />
            )}
            <RailLabel collapsed={collapsed}>{collapsed ? 'Развернуть' : 'Свернуть'}</RailLabel>
          </button>
        </div>
      </div>
    </aside>
  );
}

function RailLabel({
  collapsed,
  className,
  children,
}: {
  collapsed: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        'whitespace-nowrap transition-opacity duration-150 motion-reduce:transition-none',
        collapsed && 'opacity-0',
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
  railCollapsed,
}: {
  item: (typeof NAV_GROUPS)[number]['items'][number];
  pathname: string | null;
  onNavigate?: () => void;
  /** undefined — полный сайдбар; boolean — десктопная рейка (true = свёрнута). */
  railCollapsed?: boolean;
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
        title={railCollapsed ? item.label : undefined}
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
        {railCollapsed !== undefined ? (
          <RailLabel collapsed={railCollapsed} className="truncate">
            {item.label}
          </RailLabel>
        ) : (
          <span className="truncate">{item.label}</span>
        )}
        {item.href === '/inbox' && <InboxNavBadge collapsed={railCollapsed} />}
        {item.href === '/planning' && <PlanningNavBadge collapsed={railCollapsed} />}
      </Link>
    </li>
  );
}
