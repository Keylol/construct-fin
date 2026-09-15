'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { normalizeSearchText } from '@construct/shared';
import {
  CommandPalette,
  CommandGroup,
  CommandItem,
} from '@/components/ui/CommandPalette';
import { Money } from '@/components/ui/Money';
import {
  ArrowRight,
  Banknote,
  ClipboardList,
  Inbox,
  Package,
  Receipt,
  ShoppingCart,
  Tag,
  Truck,
  UserRound,
  Users,
  Wallet,
  type LucideIcon,
} from '@/components/ui/icons';
import { navGroupsFor } from '@/components/layout/nav-items';
import { CREATE_ACTIONS } from '@/components/layout/CreateMenu';
import { OPEN_GLOBAL_SEARCH_EVENT } from '@/components/layout/global-search';
import { useRole } from '@/hooks/useRole';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { GLOBAL_SEARCH_MIN_LENGTH, useGlobalSearch } from '@/hooks/useGlobalSearch';
import { describeSearchGroups, type SearchGroupKey } from '@/lib/search-links';

interface GlobalCommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Доп. подсказки к пунктам палитры (справа, приглушённым) — по href из NAV_ITEMS. */
const HINTS: Record<string, string> = {
  '/dashboard': 'Сводка месяца',
  '/orders': 'Продажи клиентам',
  '/transactions': 'Список доходов/расходов',
  '/warehouse': 'Остатки, закупки',
  '/salary': 'Сотрудники и выплаты',
  '/reports': 'ОПиУ, ОДДС',
  '/reports/rules': 'Подсказки категорий/контрагентов',
};

const GROUP_ICON: Record<SearchGroupKey, LucideIcon> = {
  orders: ClipboardList,
  clients: UserRound,
  suppliers: Truck,
  employees: Banknote,
  counterparties: Users,
  transactions: Receipt,
  inbox: Inbox,
  purchases: ShoppingCart,
  warehouse: Package,
  accounts: Wallet,
  categories: Tag,
};

/** Все слова запроса есть в тексте пункта — то же правило, что у поиска записей. */
function matches(query: string, text: string): boolean {
  const haystack = normalizeSearchText(text);
  return normalizeSearchText(query)
    .split(' ')
    .every((word) => haystack.includes(word));
}

/** Клавиша в подсказке — не кнопка: нажимать её нечем, это обозначение. */
function Key({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded-sm border border-border bg-card px-1.5 py-0.5 font-mono text-[11px] text-foreground">
      {children}
    </kbd>
  );
}

/**
 * Общий поиск и палитра команд (⌘K, кнопка «Поиск» в шапке, поле на Главной).
 *
 * Пустой запрос — команды и разделы, как раньше. С запросом палитра ищет записи
 * во всех разделах сразу (GET /search): заказ, клиента, операцию, строку
 * выписки, закупку, товар; клик открывает саму запись, «Показать все» — раздел
 * с тем же запросом. Раньше здесь искались только названия разделов.
 */
export function GlobalCommandPalette({ open, onOpenChange }: GlobalCommandPaletteProps) {
  const router = useRouter();
  const { role } = useRole();
  const { current } = useCurrentWorkspace();
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query, 250);

  // Единый источник — nav-items.ts с фильтром по роли: палитра не отстаёт от
  // меню, а найденное не ведёт в разделы, которых в меню роли нет.
  const navItems = useMemo(
    () =>
      navGroupsFor(role)
        .flatMap((g) => g.items)
        .map((n) => ({ ...n, hint: HINTS[n.href] })),
    [role],
  );
  const visible = useMemo(() => {
    const hrefs = new Set(navItems.map((n) => n.href));
    return (href: string) => hrefs.has(href);
  }, [navItems]);

  const trimmed = query.trim();
  const searching = trimmed.length >= GLOBAL_SEARCH_MIN_LENGTH;
  const search = useGlobalSearch(
    open ? (current?.id ?? null) : null,
    searching ? debouncedQuery : '',
  );
  const groups = useMemo(
    () => (searching && search.data ? describeSearchGroups(search.data, visible) : []),
    [searching, search.data, visible],
  );
  const waiting = searching && (search.isFetching || debouncedQuery.trim() !== trimmed);

  const setOpen = useCallback(
    (next: boolean) => {
      // Закрыли — запрос не залипает до следующего открытия.
      if (!next) setQuery('');
      onOpenChange(next);
    },
    [onOpenChange],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // e.code, а не e.key: на русской раскладке та же клавиша — «л».
      if (e.code !== 'KeyK' || !(e.metaKey || e.ctrlKey) || e.repeat) return;
      // Поверх открытого окна (форма операции, карточка заказа) палитра не выскакивает.
      if (!open && document.querySelector('[role="dialog"][data-state="open"]')) return;
      e.preventDefault();
      setOpen(!open);
    };
    const onOpenRequest = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener(OPEN_GLOBAL_SEARCH_EVENT, onOpenRequest);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(OPEN_GLOBAL_SEARCH_EVENT, onOpenRequest);
    };
  }, [open, setOpen]);

  const go = (href: string) => {
    setOpen(false);
    router.push(href as Parameters<typeof router.push>[0]);
  };

  const navShown = trimmed
    ? navItems.filter((n) => matches(trimmed, `${n.label} ${n.hint ?? ''}`)).slice(0, 5)
    : navItems;
  const createShown = trimmed
    ? CREATE_ACTIONS.filter((a) => matches(trimmed, `создать ${a.label} ${a.hint ?? ''}`))
    : CREATE_ACTIONS;

  const createGroup = createShown.length > 0 && (
    <CommandGroup heading="Создать">
      {createShown.map((a) => {
        const Icon = a.icon;
        return (
          <CommandItem key={a.href} value={`create:${a.href}`} onSelect={() => go(a.href)}>
            <Icon />
            <span>{a.label}</span>
            {a.hint && <span className="ml-auto text-xs text-muted-foreground">{a.hint}</span>}
          </CommandItem>
        );
      })}
    </CommandGroup>
  );

  return (
    <CommandPalette
      open={open}
      onOpenChange={setOpen}
      // Фильтрует не cmdk, а сервер (записи) и `matches` (разделы, команды).
      shouldFilter={false}
      inputValue={query}
      onInputValueChange={setQuery}
      placeholder="Поиск: заказ, клиент, сумма, операция…"
      emptyLabel={waiting ? 'Ищем…' : 'Ничего не найдено'}
      footer={
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>
            <Key>/</Key> поиск на экране
          </span>
          <span>
            <Key>n</Key> создать
          </span>
          <span>
            <Key>⌘</Key>
            <Key>↵</Key> подтвердить в окне
          </span>
          <span>
            <Key>Esc</Key> закрыть
          </span>
        </div>
      }
    >
      {/* Без запроса создание — первым: палитру чаще открывают, чтобы что-то
          завести. С запросом первыми идут найденное, а «Создать» — в конце. */}
      {!trimmed && createGroup}

      {navShown.length > 0 && (
        <CommandGroup heading={trimmed ? 'Разделы' : 'Навигация'}>
          {navShown.map((n) => {
            const Icon = n.icon;
            return (
              <CommandItem key={n.href} value={`nav:${n.href}`} onSelect={() => go(n.href)}>
                <Icon />
                <span>{n.label}</span>
                {n.hint && (
                  <span className="ml-auto text-xs text-muted-foreground">{n.hint}</span>
                )}
              </CommandItem>
            );
          })}
        </CommandGroup>
      )}

      {waiting && groups.length === 0 && navShown.length > 0 && (
        <div className="px-3 py-2 text-xs text-muted-foreground">Ищем записи…</div>
      )}

      {groups.map((group) => {
        const Icon = GROUP_ICON[group.key];
        const more = group.moreHref;
        return (
          <CommandGroup key={group.key} heading={`${group.heading} · ${group.total}`}>
            {group.items.map((item) => (
              <CommandItem
                key={item.id}
                value={`${group.key}:${item.id}`}
                onSelect={() => go(item.href)}
              >
                <Icon />
                <div className="min-w-0 flex-1">
                  <div className="truncate">{item.title}</div>
                  {item.subtitle && (
                    <div className="truncate text-xs text-muted-foreground">{item.subtitle}</div>
                  )}
                </div>
                {item.aside && (
                  <span className="shrink-0 text-xs text-muted-foreground">{item.aside}</span>
                )}
                {item.amount !== null && <Money value={item.amount} className="shrink-0 text-sm" />}
              </CommandItem>
            ))}
            {more && group.total > group.items.length && (
              <CommandItem value={`${group.key}:more`} onSelect={() => go(more)}>
                <ArrowRight />
                <span className="text-muted-foreground">Показать все {group.total} в разделе</span>
              </CommandItem>
            )}
          </CommandGroup>
        );
      })}

      {trimmed && createGroup}
    </CommandPalette>
  );
}
