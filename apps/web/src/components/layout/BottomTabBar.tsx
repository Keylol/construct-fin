'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Home, ClipboardList, Receipt, Menu as MenuIcon, Plus, type LucideIcon } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { Modal, ModalBody, ModalContent, ModalHeader, ModalTitle } from '@/components/ui/Modal';
import { NavList } from './Sidebar';
import { CreateMenu } from './CreateMenu';

const TABS: { href: string; label: string; icon: LucideIcon }[] = [
  { href: '/dashboard', label: 'Главная', icon: Home },
  { href: '/orders', label: 'Заказы', icon: ClipboardList },
];
const TABS_RIGHT: { href: string; label: string; icon: LucideIcon }[] = [
  { href: '/transactions', label: 'Операции', icon: Receipt },
];

/**
 * Нижний таб-бар Mini App (решение №22 блица): навигация одним пальцем на
 * <md. Центральная кнопка «+» — то же меню создания, что в шапке; «Ещё» —
 * полное меню разделов в окне снизу (Modal на телефоне — панель), а не
 * отдельной шторкой со своим кодом. Учитывает safe-area снизу.
 */
export function BottomTabBar() {
  const pathname = usePathname() ?? '/';
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
          'flex flex-1 flex-col items-center justify-center gap-0.5 py-1.5 transition-colors',
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

        <div className="flex flex-1 items-center justify-center">
          <CreateMenu
            side="top"
            align="center"
            trigger={
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
            }
          />
        </div>

        {TABS_RIGHT.map(tab)}

        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          className={cn(
            'flex flex-1 flex-col items-center justify-center gap-0.5 py-1.5 transition-colors',
            !knownActive ? 'text-primary' : 'text-muted-foreground',
          )}
        >
          <MenuIcon className="h-5 w-5" aria-hidden />
          <span className="text-[10px] font-medium leading-none">Ещё</span>
        </button>
      </nav>

      <Modal open={moreOpen} onOpenChange={setMoreOpen}>
        <ModalContent size="md">
          <ModalHeader>
            <ModalTitle>Разделы</ModalTitle>
          </ModalHeader>
          <ModalBody className="p-3">
            <NavList onNavigate={() => setMoreOpen(false)} expandAll />
          </ModalBody>
        </ModalContent>
      </Modal>
    </>
  );
}
