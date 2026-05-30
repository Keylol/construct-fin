'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Menu, Search, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/cn';
import { NAV_ITEMS } from './nav-items';
import { Sheet, SheetContent } from '@/components/ui/Sheet';
import { Sidebar } from './Sidebar';
import { Button } from '@/components/ui/Button';

interface HeaderProps {
  onCommandOpen: () => void;
}

export function Header({ onCommandOpen }: HeaderProps) {
  const pathname = usePathname() ?? '/';
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [isMac, setIsMac] = useState(false);

  useEffect(() => {
    if (typeof navigator !== 'undefined') {
      setIsMac(/Mac|iPhone|iPad/.test(navigator.platform));
    }
  }, []);

  const breadcrumbs = buildBreadcrumbs(pathname);

  return (
    <header
      className={cn(
        'sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-background px-4 sm:px-6',
      )}
    >
      {/* Mobile drawer trigger */}
      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Открыть меню"
          className="md:hidden"
          onClick={() => setDrawerOpen(true)}
        >
          <Menu className="h-5 w-5" />
        </Button>
        <SheetContent side="left" className="w-60 p-0">
          <Sidebar onNavigate={() => setDrawerOpen(false)} />
        </SheetContent>
      </Sheet>

      {/* Breadcrumbs */}
      <nav aria-label="Хлебные крошки" className="min-w-0 flex-1">
        <ol className="flex items-center gap-1 text-sm">
          {breadcrumbs.map((c, i) => {
            const isLast = i === breadcrumbs.length - 1;
            return (
              <li key={`${c.href ?? c.label}-${i}`} className="flex items-center gap-1 min-w-0">
                {c.href && !isLast ? (
                  <Link
                    href={c.href as Parameters<typeof Link>[0]['href']}
                    className="truncate text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {c.label}
                  </Link>
                ) : (
                  <span
                    className={cn(
                      'truncate',
                      isLast ? 'font-medium text-foreground' : 'text-muted-foreground',
                    )}
                  >
                    {c.label}
                  </span>
                )}
                {!isLast && (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                )}
              </li>
            );
          })}
        </ol>
      </nav>

      {/* Command palette trigger */}
      <button
        type="button"
        onClick={onCommandOpen}
        className={cn(
          'inline-flex h-8 items-center gap-2 rounded-md border border-input bg-background px-2.5 text-xs',
          'text-muted-foreground shadow-xs transition-colors hover:bg-secondary',
        )}
        aria-label="Открыть поиск"
      >
        <Search className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">Поиск</span>
        <kbd className="ml-2 hidden rounded border border-input bg-muted px-1.5 py-0.5 text-[10px] font-medium sm:inline">
          {isMac ? '⌘K' : 'Ctrl+K'}
        </kbd>
      </button>
    </header>
  );
}

interface CrumbItem {
  label: string;
  href?: string;
}

const LABELS: Record<string, string> = {
  dashboard: 'Главная',
  orders: 'Заказы',
  clients: 'Клиенты',
  suppliers: 'Поставщики',
  warehouse: 'Склад',
  transactions: 'Операции',
  accounts: 'Счета',
  categories: 'Категории',
  counterparties: 'Контрагенты',
  import: 'Импорт',
  batches: 'История',
  reports: 'Отчёты',
  cashflow: 'Cash flow',
  rules: 'Правила',
  pnl: 'P&L',
};

function buildBreadcrumbs(pathname: string): CrumbItem[] {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length === 0) return [{ label: 'Главная' }];

  // Try to match a known nav item first (e.g. /reports → "Отчёты").
  const match = NAV_ITEMS.find((n) => n.href === pathname);
  if (match && parts.length === 1) {
    return [{ label: match.label }];
  }

  return parts.map((part, i) => {
    const href = '/' + parts.slice(0, i + 1).join('/');
    const known = NAV_ITEMS.find((n) => n.href === href);
    return {
      label: known?.label ?? LABELS[part] ?? part,
      href: i < parts.length - 1 ? href : undefined,
    };
  });
}
