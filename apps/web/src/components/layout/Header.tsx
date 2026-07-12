'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { Menu, Search, ChevronRight, ChevronDown, Plus } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { NAV_ITEMS } from './nav-items';
import { Sheet, SheetContent } from '@/components/ui/Sheet';
import { Sidebar } from './Sidebar';
import { Button } from '@/components/ui/Button';

interface HeaderProps {
  onCommandOpen: () => void;
}

// Глобальное «+ Создать»: открывает форму создания на нужной странице через ?new=1
// (страницы читают его на маунте). Один клик из любого экрана.
const CREATE_ACTIONS: { label: string; href: string }[] = [
  { label: 'Операция', href: '/transactions?new=1' },
  { label: 'Заказ', href: '/orders?new=1' },
  { label: 'Закупка', href: '/purchases?new=1' },
  { label: 'Клиент', href: '/clients?new=1' },
];

function CreateMenu() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <Button size="sm" className="gap-1">
          <Plus className="h-4 w-4" />
          <span className="hidden sm:inline">Создать</span>
          <ChevronDown className="h-3.5 w-3.5 opacity-80" />
        </Button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="end"
          sideOffset={6}
          className={cn(
            'z-50 min-w-[180px] overflow-hidden rounded-md border border-border bg-card p-1 shadow-md',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
            'motion-reduce:animate-none',
          )}
        >
          {CREATE_ACTIONS.map((a) => (
            <button
              key={a.href}
              type="button"
              onClick={() => {
                setOpen(false);
                router.push(a.href as Parameters<typeof router.push>[0]);
              }}
              className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-sm text-foreground transition-colors hover:bg-secondary"
            >
              <Plus className="h-3.5 w-3.5 text-muted-foreground" />
              {a.label}
            </button>
          ))}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
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

      {/* Глобальное создание */}
      <CreateMenu />

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
    // Динамический сегмент-cuid (карточка сущности) не показываем сырым id —
    // сама карточка выводит имя в своём заголовке.
    const isId = /^c[a-z0-9]{20,}$/i.test(part) || /^[0-9a-f-]{20,}$/i.test(part);
    return {
      label: known?.label ?? LABELS[part] ?? (isId ? 'Карточка' : part),
      href: i < parts.length - 1 ? href : undefined,
    };
  });
}
