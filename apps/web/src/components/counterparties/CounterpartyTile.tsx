'use client';

import { formatRub, formatPhone, D } from '@construct/shared';
import { StatusStamp } from '@/components/ui/StatusStamp';
import { Tile } from '@/components/ui/Tile';
import { formatDate } from '@/lib/dates';
import type { Counterparty } from '@/lib/types';

/**
 * Контрагент в плиточном виде: та же анатомия, что у заказа (см. ui/Tile), но
 * в слотах — своё. Заголовок — имя, потому что человека узнают по имени, а не
 * по телефону; телефон уходит в подпись.
 */
export function CounterpartyTile({
  counterparty,
  onClick,
}: {
  counterparty: Counterparty;
  onClick: () => void;
}) {
  const s = counterparty.summary;
  const debt = s ? D(s.debt) : null;
  const contact = counterparty.contact;
  // Контакт чаще всего телефон — показываем его в том же виде, что номера
  // заказов, чтобы глаз не спотыкался о разный формат.
  const subtitle = contact
    ? /^[\d+()\s-]+$/.test(contact)
      ? formatPhone(contact)
      : contact
    : s?.lastOrderAt
      ? `последний заказ ${formatDate(s.lastOrderAt)}`
      : 'без контакта';

  return (
    <Tile
      title={counterparty.name}
      stamps={
        <>
          {s && s.ordersCount > 0 && (
            <StatusStamp tone="primary" label={`${s.ordersCount} зак.`} />
          )}
          {counterparty.isArchived && <StatusStamp tone="muted" label="Архив" />}
        </>
      }
      subtitle={subtitle}
      primary={s ? formatRub(s.ordersTotal) : undefined}
      accent={
        debt && debt.gt(0) ? (
          <span className="text-destructive">долг {formatRub(s!.debt)}</span>
        ) : undefined
      }
      onClick={onClick}
    />
  );
}
