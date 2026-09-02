'use client';

import * as React from 'react';
import { Command as CommandPrimitive } from 'cmdk';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Search } from '@/components/ui/icons';
import { cn } from '@/lib/cn';

export const CommandRoot = CommandPrimitive;

export interface CommandDialogProps extends React.ComponentProps<typeof CommandPrimitive> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Empty hint shown when the input is non-empty but matches nothing. */
  emptyLabel?: string;
  /** Placeholder for the search field. */
  placeholder?: string;
  /** Подсказка внизу окна — например, список клавиш экрана. */
  footer?: React.ReactNode;
}

export function CommandPalette({
  open,
  onOpenChange,
  placeholder = 'Что вы ищете? Cmd+K',
  emptyLabel = 'Ничего не найдено',
  footer,
  children,
  ...props
}: CommandDialogProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            'fixed inset-0 z-50 bg-foreground/40',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0',
          )}
        />
        <DialogPrimitive.Content
          className={cn(
            'fixed left-1/2 top-[15%] z-50 w-full max-w-xl -translate-x-1/2',
            'overflow-hidden rounded-lg border border-border bg-card shadow-lg',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          )}
        >
          <DialogPrimitive.Title className="sr-only">Поиск</DialogPrimitive.Title>
          <CommandPrimitive {...props} className="flex flex-col">
            <div className="flex items-center border-b border-border px-3">
              <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
              <CommandPrimitive.Input
                placeholder={placeholder}
                className={cn(
                  'flex h-11 w-full bg-transparent px-3 text-sm outline-none',
                  'placeholder:text-muted-foreground',
                  'disabled:cursor-not-allowed disabled:opacity-50',
                )}
              />
            </div>
            <CommandPrimitive.List className="max-h-[60vh] overflow-y-auto overflow-x-hidden p-1">
              <CommandPrimitive.Empty className="py-6 text-center text-sm text-muted-foreground">
                {emptyLabel}
              </CommandPrimitive.Empty>
              {children}
            </CommandPrimitive.List>
            {footer && (
              <div className="border-t border-border bg-secondary/40 px-3 py-2">{footer}</div>
            )}
          </CommandPrimitive>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export const CommandGroup = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Group>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Group>
>(function CommandGroup({ className, ...props }, ref) {
  return (
    <CommandPrimitive.Group
      ref={ref}
      className={cn(
        'overflow-hidden p-1 text-foreground',
        '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5',
        '[&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium',
        '[&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide',
        '[&_[cmdk-group-heading]]:text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
});

export const CommandItem = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Item>
>(function CommandItem({ className, ...props }, ref) {
  return (
    <CommandPrimitive.Item
      ref={ref}
      className={cn(
        'relative flex cursor-default select-none items-center gap-2 rounded-md px-2 py-2 text-sm outline-none',
        'data-[selected=true]:bg-secondary data-[selected=true]:text-foreground',
        'data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50',
        '[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
});

export const CommandSeparator = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Separator>
>(function CommandSeparator({ className, ...props }, ref) {
  return (
    <CommandPrimitive.Separator
      ref={ref}
      className={cn('-mx-1 h-px bg-border', className)}
      {...props}
    />
  );
});
