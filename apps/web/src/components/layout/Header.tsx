'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Search, ChevronRight, ChevronDown, Plus } from '@/components/ui/icons';
import { Money } from '@/components/ui/Money';
import { Button } from '@/components/ui/Button';
import { CountBadge } from '@/components/ui/CountBadge';
import { cn } from '@/lib/cn';
import { NAV_ITEMS } from './nav-items';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useTotalCash } from '@/hooks/useTotalCash';
import { CreateMenu } from './CreateMenu';

interface HeaderProps {
  onCommandOpen: () => void;
}

/**
 * Деньги в шапке (решение №19): главный вопрос владельца виден с любого
 * экрана. По банку там, где банк отдаёт остаток, иначе по учёту; рядом —
 * очередь разбора. Оба — обычные кнопки-ссылки системы, а не свои чипы.
 */
function HeaderCash() {
  const { current } = useCurrentWorkspace();
  const wsId = current?.id ?? null;
  const { total, hasBank, unresolvedCount } = useTotalCash(wsId);

  if (total == null) return null;

  return (
    <div className="hidden items-center gap-1.5 sm:flex">
      <Button
        asChild
        variant="secondary"
        size="sm"
        className="gap-2"
      >
        <Link
          href="/accounts"
          title={hasBank ? 'По данным банков (где есть API) — открыть счета' : 'Денежные средства на счетах — открыть'}
        >
          <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {hasBank ? 'По банку' : 'Денежные средства'}
          </span>
          <Money value={total} className="font-semibold" />
        </Link>
      </Button>
      {unresolvedCount > 0 && (
        <Button asChild variant="ghost" size="sm" className="gap-1.5 text-muted-foreground">
          <Link href="/inbox" title="Строки выписки, которые ещё не проведены — открыть «Входящие»">
            не разобрано
            <CountBadge count={unresolvedCount} tone="warning" />
          </Link>
        </Button>
      )}
    </div>
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
        'sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-background px-4 sm:px-6',
      )}
    >
      {/* Мобильное меню живёт в нижнем таб-баре («Ещё») — гамбургер не нужен. */}

      {!showBreadcrumbs && <div className="min-w-0 flex-1" />}
      {showBreadcrumbs && (
        <nav aria-label="Хлебные крошки" className="min-w-0 flex-1">
          <ol className="flex items-center gap-1 text-sm">
            {breadcrumbs.map((c, i) => {
              const isLast = i === breadcrumbs.length - 1;
              return (
                <li key={`${c.href ?? c.label}-${i}`} className="flex min-w-0 items-center gap-1">
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
                  {!isLast && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                </li>
              );
            })}
          </ol>
        </nav>
      )}

      <HeaderCash />

      {/* Глобальное создание (десктоп; на телефоне — центр таб-бара) */}
      <div className="hidden md:block">
        <CreateMenu
          trigger={
            <Button size="sm" className="gap-1">
              <Plus className="h-4 w-4" />
              <span className="hidden sm:inline">Создать</span>
              <ChevronDown className="h-3.5 w-3.5 opacity-80" />
            </Button>
          }
        />
      </div>

      {/* Палитра: кнопка выглядит как поле поиска — это и есть вход в поиск. */}
      <Button
        variant="secondary"
        size="sm"
        onClick={onCommandOpen}
        aria-label="Открыть поиск"
        className="gap-2 font-normal text-muted-foreground"
      >
        <Search className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">Поиск</span>
        <kbd className="hidden rounded-sm border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] font-medium text-foreground sm:inline">
          {isMac ? '⌘K' : 'Ctrl+K'}
        </kbd>
      </Button>
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
