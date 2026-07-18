'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  CommandPalette,
  CommandGroup,
  CommandItem,
} from '@/components/ui/CommandPalette';
import { NAV_ITEMS } from '@/components/layout/nav-items';

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

/** Единый источник — NAV_GROUPS/NAV_ITEMS (nav-items.ts), палитра не отстаёт от меню. */
const QUICK_NAV = NAV_ITEMS.map((n) => ({ ...n, hint: HINTS[n.href] }));

export function GlobalCommandPalette({ open, onOpenChange }: GlobalCommandPaletteProps) {
  const router = useRouter();

  // Cmd/Ctrl+K shortcut — only when nothing else is editing/listening.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  const go = (href: string) => {
    onOpenChange(false);
    router.push(href as Parameters<typeof router.push>[0]);
  };

  return (
    <CommandPalette
      open={open}
      onOpenChange={onOpenChange}
      placeholder="Куда перейти?"
      emptyLabel="Ничего не найдено"
    >
      <CommandGroup heading="Навигация">
        {QUICK_NAV.map((n) => {
          const Icon = n.icon;
          return (
            <CommandItem key={n.href} value={`${n.label} ${n.hint ?? ''}`} onSelect={() => go(n.href)}>
              <Icon />
              <span>{n.label}</span>
              {n.hint && (
                <span className="ml-auto text-xs text-muted-foreground">{n.hint}</span>
              )}
            </CommandItem>
          );
        })}
      </CommandGroup>
    </CommandPalette>
  );
}
