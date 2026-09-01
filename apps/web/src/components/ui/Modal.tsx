'use client';

import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cva, type VariantProps } from 'class-variance-authority';
import { X } from '@/components/ui/icons';
import { cn } from '@/lib/cn';

/**
 * Окно поверх содержимого — единственный способ показать форму или карточку
 * сущности. Пришло на смену правой шторке: владелец работает с широкого экрана,
 * и документ на 8 позиций в полосе 448px не помещался, а список за ней всё
 * равно был не нужен.
 *
 * Одно окно ведёт себя по-разному по ширине экрана, и это заложено здесь, а не
 * в вызывающем коде:
 *   • десктоп — по центру, ширина по `size`, углы скруглены со всех сторон;
 *   • телефон — панель снизу во всю ширину, кнопки под большим пальцем.
 *
 * API повторяет Sheet один в один, чтобы перенос экрана был заменой имён:
 * Modal / ModalContent / ModalHeader / ModalBody / ModalFooter / ModalTitle.
 */
export const Modal = DialogPrimitive.Root;
export const ModalTrigger = DialogPrimitive.Trigger;
export const ModalClose = DialogPrimitive.Close;
export const ModalPortal = DialogPrimitive.Portal;

export const ModalOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(function ModalOverlay({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Overlay
      ref={ref}
      className={cn(
        'fixed inset-0 z-50 bg-foreground/40',
        'data-[state=open]:animate-in data-[state=closed]:animate-out',
        'data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0',
        'motion-reduce:animate-none',
        className,
      )}
      {...props}
    />
  );
});

// Базовые классы описывают телефон (панель снизу), ветка sm: поднимает окно в
// центр. Мобильное — база сознательно: так классы не спорят друг с другом за
// порядок в готовом CSS, как спорили бы `left-1/2` и его мобильная отмена.
const modalVariants = cva(
  'fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] flex-col rounded-t-lg border border-border ' +
    // Панель — off-white (решение №30 блица): белые поля читаются «окнами» на ней.
    'bg-background text-foreground shadow-lg ' +
    'data-[state=open]:animate-in data-[state=closed]:animate-out ' +
    'data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 ' +
    'data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom ' +
    'data-[state=closed]:duration-200 data-[state=open]:duration-300 ' +
    'motion-reduce:animate-none ' +
    // Десктоп: центр экрана, въезд снизу гасится в пользу лёгкого зума.
    // Поля по бокам обязательны: без них окно шириной в экран упирается в края
    // на ноутбуке и перестаёт читаться как окно.
    'sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:w-[calc(100%-4rem)] ' +
    'sm:max-h-[90dvh] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-lg ' +
    'sm:data-[state=open]:slide-in-from-bottom-0 sm:data-[state=closed]:slide-out-to-bottom-0 ' +
    'sm:data-[state=open]:zoom-in-95 sm:data-[state=closed]:zoom-out-95',
  {
    variants: {
      // Ширина действует только на десктопе: на телефоне окно всегда во всю
      // ширину. Справочники — md/lg, документы (заказ, закупка) — xl/2xl.
      size: {
        md: 'sm:max-w-md',
        lg: 'sm:max-w-lg',
        xl: 'sm:max-w-3xl',
        '2xl': 'sm:max-w-5xl',
        full: 'sm:max-w-[min(1400px,calc(100vw-4rem))]',
      },
    },
    defaultVariants: { size: 'md' },
  },
);

export interface ModalContentProps
  extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>,
    VariantProps<typeof modalVariants> {
  hideClose?: boolean;
}

export const ModalContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  ModalContentProps
>(function ModalContent({ size, className, children, hideClose, ...props }, ref) {
  return (
    <ModalPortal>
      <ModalOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(modalVariants({ size }), className)}
        {...props}
      >
        {!hideClose && (
          <DialogPrimitive.Close
            className="absolute right-4 top-4 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            aria-label="Закрыть"
          >
            <X className="h-4 w-4" />
          </DialogPrimitive.Close>
        )}
        {children}
      </DialogPrimitive.Content>
    </ModalPortal>
  );
});

/** Шапка окна — остаётся на месте, пока тело скроллится. */
export function ModalHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-1.5 border-b border-border p-6', className)} {...props} />;
}

/** Единственная скроллящаяся часть окна. */
export function ModalBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex-1 overflow-y-auto p-6', className)} {...props} />;
}

/**
 * Кнопки действия. На телефоне снизу добавляется безопасная зона — иначе
 * «Сохранить» уезжает под системную полосу жестов.
 */
export function ModalFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex flex-col-reverse gap-2 border-t border-border p-6',
        'pb-[calc(1.5rem+env(safe-area-inset-bottom))] sm:pb-6',
        'sm:flex-row sm:justify-end',
        className,
      )}
      {...props}
    />
  );
}

export const ModalTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(function ModalTitle({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Title
      ref={ref}
      className={cn('text-base font-semibold leading-none tracking-tight', className)}
      {...props}
    />
  );
});

export const ModalDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(function ModalDescription({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Description
      ref={ref}
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  );
});
