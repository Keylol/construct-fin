'use client';

import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/Menu';
import {
  ClipboardList,
  Receipt,
  ShoppingCart,
  UserRound,
  FileText,
  type LucideIcon,
} from '@/components/ui/icons';

/**
 * Глобальное «+ Создать»: открывает форму создания на нужном экране через
 * ?new=1 (экраны читают его на маунте). Один список для шапки (десктоп),
 * центральной кнопки таб-бара (телефон) и палитры — источник здесь.
 */
export const CREATE_ACTIONS: { label: string; href: string; icon: LucideIcon; hint?: string }[] = [
  { label: 'Заказ', href: '/orders?new=1', icon: ClipboardList },
  { label: 'Операция', href: '/transactions?new=1', icon: Receipt },
  { label: 'Закупка', href: '/purchases?new=1', icon: ShoppingCart },
  { label: 'Клиент', href: '/clients?new=1', icon: UserRound },
  { label: 'Разобрать чек', href: '/purchases/wb-receipt', icon: FileText, hint: 'PDF WB, ДНС, ОТ' },
];

export function CreateMenu({
  trigger,
  side,
  align = 'end',
}: {
  /** Кнопка-триггер; получает asChild-пропсы Popover. */
  trigger: ReactNode;
  side?: 'top' | 'bottom';
  align?: 'start' | 'center' | 'end';
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger asChild>{trigger}</MenuTrigger>
      <MenuContent side={side} align={align} label="Создать">
        {CREATE_ACTIONS.map((a) => (
          <MenuItem
            key={a.href}
            icon={a.icon}
            hint={a.hint}
            onSelect={() => {
              setOpen(false);
              router.push(a.href as Parameters<typeof router.push>[0]);
            }}
          >
            {a.label}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}
