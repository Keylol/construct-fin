'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { Home, ClipboardList, Receipt, Menu, Plus, type LucideIcon } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { Sheet, SheetContent } from '@/components/ui/Sheet';
import { Sidebar } from './Sidebar';
import { CreateActionsContent, CREATE_POPOVER_CLASSES } from './create-actions';

const TABS: { href: string; label: string; icon: LucideIcon }[] = [
  { href: '/dashboard', label: 'Главная', icon: Home },
  { href: '/orders', label: 'Заказы', icon: ClipboardList },
];
const TABS_RIGHT: { href: string; label: string; icon: LucideIcon }[] = [
  { href: '/transactions', label: 'Операции', icon: Receipt },
];

/**
 * Нижний таб-бар Mini App (решение №22 блица, отдельная М-волна): навигация
 * одним пальцем на <md. Центральная кнопка «+» — глобальное создание
 * (заменяет FAB), «Ещё» открывает полное меню drawer-ом. Учитывает
 * safe-area снизу (Telegram/iOS).
 */
export function BottomTabBar() {
  const pathname = usePathname() ?? '/';
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  const isActive = (href: string) => pathname === href || pathname?.startsWith(href + '/');
  const knownActive = [...TABS, ...TABS_RIGHT].some((t) => isActive(t.href));

  const tab = (t: { href: string; label: string; icon: LucideIcon }) => {
    const active = isActive(t.href);
    const Icon = t.icon;
    return (
      <Link
        key={t.href}
        href={t.href as Parameters<typeof Link>[0]['href']}
        className={cn(
          'flex flex-1 flex-col items-center justify-center gap-0.5 py-1.5',
          'transition-colors',
          active ? 'text-primary' : 'text-muted-foreground',
        )}
      >
        <Icon className="h-5 w-5" aria-hidden />
        <span className="text-[10px] font-medium leading-none">{t.label}</span>
      </Link>
    );
  };

  return (
    <>
      <nav
        aria-label="Нижняя навигация"
        className={cn(
          'fixed inset-x-0 bottom-0 z-40 flex items-stretch border-t border-border bg-card md:hidden',
          'pb-[env(safe-area-inset-bottom)]',
        )}
      >
        {TABS.map(tab)}

        {/* Центральная кнопка «+» — глобальное создание */}
        <div className="flex flex-1 items-center justify-center">
          <PopoverPrimitive.Root open={createOpen} onOpenChange={setCreateOpen}>
            <PopoverPrimitive.Trigger asChild>
              <button
                type="button"
                aria-label="Создать"
                className={cn(
                  '-mt-5 flex h-12 w-12 items-center justify-center rounded-full',
                  'bg-primary text-primary-foreground shadow-lg',
                  'transition-transform active:scale-95 motion-reduce:transition-none',
                )}
              >
                <Plus className="h-6 w-6" />
              </button>
            </PopoverPrimitive.Trigger>
            <PopoverPrimitive.Portal>
              <PopoverPrimitive.Content
                side="top"
                align="center"
                sideOffset={10}
                className={CREATE_POPOVER_CLASSES}
              >
                <CreateActionsContent
                  onPick={(href) => {
                    setCreateOpen(false);
                    router.push(href as Parameters<typeof router.push>[0]);
                  }}
                />
              </PopoverPrimitive.Content>
            </PopoverPrimitive.Portal>
          </PopoverPrimitive.Root>
        </div>

        {TABS_RIGHT.map(tab)}

        {/* «Ещё» — полное меню drawer-ом */}
        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          className={cn(
            'flex flex-1 flex-col items-center justify-center gap-0.5 py-1.5 transition-colors',
            !knownActive ? 'text-primary' : 'text-muted-foreground',
          )}
        >
          <Menu className="h-5 w-5" aria-hidden />
          <span className="text-[10px] font-medium leading-none">Ещё</span>
        </button>
      </nav>

      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetContent side="left" className="w-60 p-0">
          <Sidebar onNavigate={() => setMoreOpen(false)} />
        </SheetContent>
      </Sheet>
    </>
  );
}
