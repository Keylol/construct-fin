'use client';

import { Plus } from '@/components/ui/icons';
import { cn } from '@/lib/cn';

/**
 * Глобальное «+ Создать»: открывает форму создания на нужной странице через
 * ?new=1 (страницы читают его на маунте). Общий список для меню в хедере
 * (десктоп) и центральной кнопки таб-бара (мобайл).
 */
export const CREATE_ACTIONS: { label: string; href: string }[] = [
  { label: 'Операция', href: '/transactions?new=1' },
  { label: 'Заказ', href: '/orders?new=1' },
  { label: 'Закупка', href: '/purchases?new=1' },
  { label: 'Клиент', href: '/clients?new=1' },
];

export const CREATE_POPOVER_CLASSES = cn(
  'z-50 min-w-[180px] overflow-hidden rounded-md border border-border bg-card p-1 shadow-md',
  'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
  'motion-reduce:animate-none',
);

export function CreateActionsContent({ onPick }: { onPick: (href: string) => void }) {
  return (
    <>
      {CREATE_ACTIONS.map((a) => (
        <button
          key={a.href}
          type="button"
          onClick={() => onPick(a.href)}
          className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-sm text-foreground transition-colors hover:bg-secondary"
        >
          <Plus className="h-3.5 w-3.5 text-muted-foreground" />
          {a.label}
        </button>
      ))}
    </>
  );
}
