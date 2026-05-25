'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  Home,
  Receipt,
  Wallet,
  Tag,
  Users,
  Repeat,
  Upload,
  BarChart3,
  Filter,
} from 'lucide-react';
import {
  CommandPalette,
  CommandGroup,
  CommandItem,
} from '@/components/ui/CommandPalette';

interface GlobalCommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface QuickNav {
  href: string;
  label: string;
  icon: typeof Home;
  hint?: string;
}

const QUICK_NAV: QuickNav[] = [
  { href: '/dashboard', label: 'Главная', icon: Home, hint: 'Сводка месяца' },
  { href: '/transactions', label: 'Операции', icon: Receipt, hint: 'Список доходов/расходов' },
  { href: '/recurring', label: 'Регулярные операции', icon: Repeat },
  { href: '/import', label: 'Импорт выписки', icon: Upload },
  { href: '/accounts', label: 'Счета', icon: Wallet },
  { href: '/categories', label: 'Категории', icon: Tag },
  { href: '/counterparties', label: 'Контрагенты', icon: Users },
  { href: '/reports', label: 'Отчёты', icon: BarChart3, hint: 'P&L, Cash flow' },
  { href: '/reports/rules', label: 'Правила категоризации', icon: Filter },
];

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
