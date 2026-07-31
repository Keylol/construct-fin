'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { Search, ChevronRight, ChevronDown, Plus } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { NAV_ITEMS } from './nav-items';
import { Button } from '@/components/ui/Button';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useTotalCash } from '@/hooks/useTotalCash';
import { formatRub } from '@construct/shared';
import { CreateActionsContent, CREATE_POPOVER_CLASSES } from './create-actions';

interface HeaderProps {
  onCommandOpen: () => void;
}

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
        <PopoverPrimitive.Content align="end" sideOffset={6} className={CREATE_POPOVER_CLASSES}>
          <CreateActionsContent
            onPick={(href) => {
              setOpen(false);
              router.push(href as Parameters<typeof router.push>[0]);
            }}
          />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

/**
 * «Всего денег» в хедере (решение №19): главный вопрос владельца виден из
 * любого экрана. Сумма активных счетов; клик — на /accounts.
 */
function HeaderCash() {
  const { current } = useCurrentWorkspace();
  const wsId = current?.id ?? null;
  const { total } = useTotalCash(wsId);

  if (total == null) return null;

  return (
    <Link
      href="/accounts"
      title="Денежные средства на счетах — открыть"
      className={cn(
        'hidden h-8 items-center gap-2 rounded-md border border-border bg-card px-2.5 sm:flex',
        'transition-colors hover:border-ring',
      )}
    >
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Денежные средства
      </span>
      <span className="num text-sm font-semibold">{formatRub(total)}</span>
    </Link>
  );
}

export function Header({ onCommandOpen }: HeaderProps) {
  const pathname = usePathname() ?? '/';
  const [isMac, setIsMac] = useState(false);

  useEffect(() => {
    if (typeof navigator !== 'undefined') {
      setIsMac(/Mac|iPhone|iPad/.test(navigator.platform));
    }
  }, []);

  const breadcrumbs = buildBreadcrumbs(pathname);
  // Крошка из одного сегмента дословно повторяет заголовок, который страница
  // рисует сама («Закупки» в плашке и сразу под ней «Закупки»). Дубль убираем
  // здесь один раз, а не на двадцати страницах; путь из нескольких сегментов
  // («Отчёты › Правила») остаётся — там крошки несут навигацию.
  const showBreadcrumbs = breadcrumbs.length > 1;

  return (
    <header
      className={cn(
        'sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-background px-4 sm:px-6',
      )}
    >
      {/* Мобильное меню живёт в нижнем таб-баре («Ещё») — гамбургер не нужен. */}

      {/* Breadcrumbs (только вложенные пути — см. showBreadcrumbs выше) */}
      {!showBreadcrumbs && <div className="min-w-0 flex-1" />}
      {showBreadcrumbs && (
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
      )}

      {/* Денежные средства — сумма по всем счетам */}
      <HeaderCash />

      {/* Глобальное создание (десктоп; на мобиле — центр таб-бара) */}
      <div className="hidden md:block">
        <CreateMenu />
      </div>

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
  transfers: 'Переводы',
  'wb-receipt': 'Обработка закупки',
  dashboard: 'Главная',
  orders: 'Заказы',
  clients: 'Клиенты',
  suppliers: 'Поставщики',
  warehouse: 'Склад',
  transactions: 'Операции',
  accounts: 'Счета',
  categories: 'По категориям',
  counterparties: 'По контрагентам',
  import: 'Импорт',
  salary: 'Зарплата',
  batches: 'История',
  reports: 'Отчёты',
  cashflow: 'ОДДС',
  balance: 'Баланс',
  breakeven: 'Безубыточность',
  budget: 'Бюджет',
  rules: 'Правила',
  pnl: 'ОПиУ',
  margin: 'Валовая прибыль',
  receivables: 'Дебиторская задолженность',
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
