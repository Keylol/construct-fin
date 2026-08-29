'use client';

import { formatRub, formatPhone, sub, toMoneyString, D } from '@construct/shared';
import { StatusStamp } from '@/components/ui/StatusStamp';
import { Tile } from '@/components/ui/Tile';
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
 * Заказ в плиточном виде. Анатомия общая (см. ui/Tile), здесь только данные:
 * заголовок — телефон, потому что именно по нему владелец опознаёт заказ
 * (в спецификациях он и стоит номером); служебный ORD виден лишь в карточке.
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
    <Tile
      title={order.phone ? formatPhone(order.phone) : order.number}
      stamps={
        <>
          <StatusStamp
            tone={labels.statusTone[order.status]}
            label={labels.statusLabel[order.status]}
          />
          <StatusStamp
            tone={labels.payTone[order.paymentStatus]}
            label={labels.payLabel[order.paymentStatus]}
          />
        </>
      }
      subtitle={order.client?.name ?? 'Без клиента'}
      primary={formatRub(order.totalAmount)}
      accent={
        hasDebt ? (
          <span className="text-destructive">долг {formatRub(debt)}</span>
        ) : marginKnown ? (
          <span className="text-success">+{formatRub(margin.margin)}</span>
        ) : undefined
      }
      onClick={onClick}
    />
  );
}

/**
 * Плитка-«папка»: несколько заказов на один телефон. Клик раскрывает их —
 * заказы повторного клиента не должны прятаться друг за другом.
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
    <Tile
      title={formatPhone(phone)}
      stamps={<StatusStamp tone="primary" label={`${orders.length} заказа`} />}
      subtitle={client ?? 'Без клиента'}
      primary={formatRub(toMoneyString(total))}
      accent={
        debt.gt(0) ? (
          <span className="text-destructive">долг {formatRub(toMoneyString(debt))}</span>
        ) : undefined
      }
      selected={expanded}
      onClick={onToggle}
    />
  );
}
