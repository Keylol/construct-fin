'use client';

/**
 * Общее для экрана заказов: как называются и каким цветом читаются состояния,
 * когда заказ можно закрыть, и строка «подпись — значение», из которой собраны
 * карточка заказа и график платежей. Вынесено из page.tsx, чтобы список, форма
 * и карточка ссылались на один словарь, а не расходились по копиям.
 */
import type { BadgeProps } from '@/components/ui/Badge';
import { cn } from '@/lib/cn';
import type { Order, OrderPaymentState, OrderStatus, ScheduleEntryStatus } from '@/lib/types';

export const STATUS_LABEL: Record<OrderStatus, string> = {
  OPEN: 'В работе',
  DONE: 'Закрыт',
  CANCELLED: 'Отменён',
};
// Тон точки/штампа (решение №15/№3): статус — вторичный сигнал, не пилюля.
export type StatusTone = 'success' | 'warning' | 'destructive' | 'muted' | 'primary';
export const STATUS_TONE: Record<OrderStatus, StatusTone> = {
  OPEN: 'primary',
  DONE: 'success',
  CANCELLED: 'muted',
};
export const PAY_LABEL: Record<OrderPaymentState, string> = {
  UNPAID: 'Не оплачен',
  PARTIAL: 'Частично',
  PAID: 'Оплачен',
  OVERPAID: 'Переплата',
  REFUNDED: 'Возврат',
};
export const PAY_TONE: Record<OrderPaymentState, StatusTone> = {
  UNPAID: 'muted',
  PARTIAL: 'warning',
  PAID: 'success',
  OVERPAID: 'warning',
  REFUNDED: 'destructive',
};

/**
 * Заказ оплачен полностью, но всё ещё открыт: деньги пришли, а признание
 * выручки не состоялось — такой заказ теряется в списке до сверки месяца.
 * Переплату включаем: она тоже означает, что денег хватает.
 */
export function canCloseOrder(o: Order): boolean {
  return o.status === 'OPEN' && (o.paymentStatus === 'PAID' || o.paymentStatus === 'OVERPAID');
}

export const SCHED_LABEL: Record<ScheduleEntryStatus, string> = {
  PAID: 'Оплачен',
  PARTIAL: 'Частично',
  PENDING: 'Ожидается',
  OVERDUE: 'Просрочен',
};
export const SCHED_VARIANT: Record<ScheduleEntryStatus, BadgeProps['variant']> = {
  PAID: 'success',
  PARTIAL: 'outline',
  PENDING: 'muted',
  OVERDUE: 'destructive',
};

export function Row({
  label,
  value,
  strong,
  tone,
}: {
  label: string;
  value: string;
  strong?: boolean;
  tone?: 'pos' | 'neg';
}) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={cn(
          'tabular-nums',
          strong && 'font-semibold',
          tone === 'pos' && 'text-success',
          tone === 'neg' && 'text-destructive',
        )}
      >
        {value}
      </span>
    </div>
  );
}
