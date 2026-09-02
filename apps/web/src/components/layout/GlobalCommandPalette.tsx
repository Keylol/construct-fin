'use client';

import { useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import {
  CommandPalette,
  CommandGroup,
  CommandItem,
} from '@/components/ui/CommandPalette';
import { NAV_ITEMS } from '@/components/layout/nav-items';
import { CREATE_ACTIONS } from '@/components/layout/create-actions';
import { Plus, Receipt } from '@/components/ui/icons';

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

/** Клавиша в подсказке — не кнопка: нажимать её нечем, это обозначение. */
function Key({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded-sm border border-border bg-card px-1.5 py-0.5 font-mono text-[11px] text-foreground">
      {children}
    </kbd>
  );
}

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
      placeholder="Команда или раздел"
      emptyLabel="Ничего не найдено"
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
      {/* Создание — первым: чаще всего палитру открывают, чтобы что-то завести,
          а не чтобы перейти. Формы открываются тем же ?new=1, что и «+ Создать». */}
      <CommandGroup heading="Создать">
        {CREATE_ACTIONS.map((a) => (
          <CommandItem key={a.href} value={`создать ${a.label}`} onSelect={() => go(a.href)}>
            <Plus />
            <span>{a.label}</span>
          </CommandItem>
        ))}
        <CommandItem
          value="разобрать чек pdf закупка"
          onSelect={() => go('/purchases/wb-receipt')}
        >
          <Receipt />
          <span>Разобрать чек</span>
          <span className="ml-auto text-xs text-muted-foreground">PDF Wildberries, ДНС, ОТ</span>
        </CommandItem>
      </CommandGroup>

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
