'use client';

import * as React from 'react';
import { Command as CommandPrimitive } from 'cmdk';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { Check, type LucideIcon } from '@/components/ui/icons';
import { cn } from '@/lib/cn';

/**
 * Выпадающее меню действий — «+ Создать» в шапке и таб-баре, выбор
 * пространства в боковой панели. Тот же Popover и тот же список cmdk, что у
 * Combobox и палитры: стрелки, Enter, Esc и подсветка пункта работают
 * одинаково везде, а вид пункта совпадает с пунктом палитры. До этого меню
 * шапки было голым Popover со своими классами на каждой кнопке.
 *
 *   <Menu>
 *     <MenuTrigger asChild><Button>…</Button></MenuTrigger>
 *     <MenuContent align="end">
 *       <MenuItem icon={Plus} onSelect={…}>Заказ</MenuItem>
 *     </MenuContent>
 *   </Menu>
 */
export const Menu = PopoverPrimitive.Root;
export const MenuTrigger = PopoverPrimitive.Trigger;

export const MenuContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content> & { label?: string }
>(function MenuContent({ className, children, align = 'end', sideOffset = 6, label, ...props }, ref) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        ref={ref}
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'z-50 min-w-[200px] overflow-hidden rounded-md border border-border bg-card shadow-md',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          'motion-reduce:animate-none',
          className,
        )}
        {...props}
      >
        {/* cmdk без поля ввода: список с клавиатурной навигацией. shouldFilter
            выключен — в меню нечего фильтровать. */}
        <CommandPrimitive loop shouldFilter={false} label={label} className="flex flex-col">
          <CommandPrimitive.List className="max-h-[60vh] overflow-y-auto p-1">{children}</CommandPrimitive.List>
        </CommandPrimitive>
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  );
});

export const MenuGroup = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Group>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Group>
>(function MenuGroup({ className, ...props }, ref) {
  return (
    <CommandPrimitive.Group
      ref={ref}
      className={cn(
        'overflow-hidden text-foreground',
        '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5',
        '[&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold',
        '[&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide',
        '[&_[cmdk-group-heading]]:text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
});

export interface MenuItemProps
  extends Omit<React.ComponentPropsWithoutRef<typeof CommandPrimitive.Item>, 'value'> {
  icon?: LucideIcon;
  /** Подсказка справа приглушённым: «PDF Wildberries, ДНС, ОТ». */
  hint?: React.ReactNode;
  /** Выбранный пункт (галочка слева) — для меню-переключателей. */
  active?: boolean;
  /** Ключ для cmdk; по умолчанию — текст пункта. */
  value?: string;
}

export const MenuItem = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Item>,
  MenuItemProps
>(function MenuItem({ className, icon: Icon, hint, active, value, children, ...props }, ref) {
  const key = value ?? (typeof children === 'string' ? children : undefined);
  return (
    <CommandPrimitive.Item
      ref={ref}
      value={key}
      className={cn(
        'relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-2 text-sm outline-none',
        'data-[selected=true]:bg-secondary data-[selected=true]:text-foreground',
        'data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50',
        active && 'font-medium',
        className,
      )}
      {...props}
    >
      {active !== undefined ? (
        <span className="flex h-4 w-4 shrink-0 items-center justify-center text-primary">
          {active && <Check className="h-3.5 w-3.5" />}
        </span>
      ) : (
        Icon && <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      )}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="ml-3 shrink-0 text-xs text-muted-foreground">{hint}</span>}
    </CommandPrimitive.Item>
  );
});

export const MenuSeparator = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Separator>
>(function MenuSeparator({ className, ...props }, ref) {
  return (
    <CommandPrimitive.Separator
      ref={ref}
      alwaysRender
      className={cn('-mx-1 my-1 h-px bg-border', className)}
      {...props}
    />
  );
});
