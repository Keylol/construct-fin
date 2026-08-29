'use client';

import { formatRub, formatPhone, sub, toMoneyString, D } from '@construct/shared';
import { StatusStamp } from '@/components/ui/StatusStamp';
import { cn } from '@/lib/cn';
import type { Order, OrderStatus, OrderPaymentState } from '@/lib/types';

/** Тон штампа — тот же набор, что у списка заказов (решение №15/№3). */
type StatusTone = 'success' | 'warning' | 'destructive' | 'muted' | 'primary';

export interface TileLabels {
  statusLabel: Record<OrderStatus, string>;
  statusTone: Record<OrderStatus, StatusTone>;
  payLabel: Record<OrderPaymentState, string>;
  payTone: Record<OrderPaymentState, StatusTone>;
}

/**
 * Плитка заказа: компактная, три строки.
 *
 * Заголовок — телефон клиента: именно по нему владелец опознаёт заказ (в
 * спецификациях он и стоит номером). Служебный ORD виден только в карточке.
 */
export function OrderTile({
  order,
  labels,
  onClick,
}: {
  order: Order;
  labels: TileLabels;
  onClick: () => void;
}) {
  const debt = toMoneyString(sub(order.totalAmount, order.paidAmount));
  const hasDebt = D(debt).gt(0);
  const margin = order.margin;
  // Прибыль показываем, только когда себестоимость фактическая: у открытого
  // заказа она ещё оценочная (склад спишется другой партией) — выдавать её за
  // факт нельзя.
  const marginKnown = !!margin && !margin.isEstimate && D(margin.cogs).gt(0);

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full flex-col gap-1.5 rounded-md border border-border bg-card px-3.5 py-3 text-left',
        'transition-colors hover:border-primary/40 hover:bg-secondary/30',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium tabular-nums">
          {order.phone ? formatPhone(order.phone) : order.number}
        </span>
        <span className="flex shrink-0 gap-1">
          <StatusStamp
            tone={labels.statusTone[order.status]}
            label={labels.statusLabel[order.status]}
          />
          <StatusStamp
            tone={labels.payTone[order.paymentStatus]}
            label={labels.payLabel[order.paymentStatus]}
          />
        </span>
      </div>

      <div className="truncate text-sm text-muted-foreground">
        {order.client?.name ?? 'Без клиента'}
      </div>

      <div className="flex items-baseline justify-between gap-2">
        <span className="text-base font-semibold tabular-nums">
          {formatRub(order.totalAmount)}
        </span>
        {hasDebt ? (
          <span className="text-xs tabular-nums text-destructive">долг {formatRub(debt)}</span>
        ) : marginKnown ? (
          <span className="text-xs tabular-nums text-success">+{formatRub(margin.margin)}</span>
        ) : null}
      </div>
    </button>
  );
}

/**
 * Плитка-«папка»: несколько заказов на один телефон. Клик раскрывает их —
 * заказы повторного клиента не должны прятаться друг за другом в списке.
 */
export function OrderGroupTile({
  phone,
  orders,
  expanded,
  onToggle,
}: {
  phone: string;
  orders: Order[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const total = orders.reduce((acc, o) => acc.plus(D(o.totalAmount)), D(0));
  const debt = orders.reduce((acc, o) => acc.plus(D(o.totalAmount).minus(D(o.paidAmount))), D(0));
  const client = orders.find((o) => o.client)?.client?.name;

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className={cn(
        'flex w-full flex-col gap-1.5 rounded-md border px-3.5 py-3 text-left transition-colors',
        expanded
          ? 'border-primary/40 bg-secondary/40'
          : 'border-border bg-card hover:border-primary/40 hover:bg-secondary/30',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium tabular-nums">{formatPhone(phone)}</span>
        <StatusStamp tone="primary" label={`${orders.length} заказа`} />
      </div>
      <div className="truncate text-sm text-muted-foreground">{client ?? 'Без клиента'}</div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-base font-semibold tabular-nums">
          {formatRub(toMoneyString(total))}
        </span>
        {debt.gt(0) && (
          <span className="text-xs tabular-nums text-destructive">
            долг {formatRub(toMoneyString(debt))}
          </span>
        )}
      </div>
    </button>
  );
}
