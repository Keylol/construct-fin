'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Money } from '@/components/ui/Money';
import { Skeleton } from '@/components/ui/Skeleton';
import { ErrorState } from '@/components/ui/ErrorState';
import { EmptyState } from '@/components/ui/EmptyState';
import { StatusStamp } from '@/components/ui/StatusStamp';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { toast } from '@/components/ui/Toaster';
import {
  Modal,
  ModalBody,
  ModalClose,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/Modal';
import { Handshake } from '@/components/ui/icons';
import { useCrmMatch, useLinkCrmDealsBulk } from '@/hooks/useCrm';
import { formatDate } from '@/lib/dates';
import { plural } from '@/lib/plural';
import type { CrmMatchItem, CrmMatchReason } from '@/lib/types';

/** Почему пара предложена — человеческим языком, с тоном доверия. */
const REASON: Record<CrmMatchReason, { label: string; tone: 'success' | 'warning' | 'muted' }> = {
  phone_and_sum: { label: 'Телефон и сумма', tone: 'success' },
  name_and_sum: { label: 'Имя и сумма', tone: 'warning' },
  phone: { label: 'Только телефон', tone: 'warning' },
  sum_and_date: { label: 'Сумма и дата', tone: 'muted' },
};

type Filter = 'confident' | 'all';

/**
 * Сопоставление сделок amoCRM с заказами, которые уже заведены в учёте.
 *
 * Пары считает сервер; человек снимает лишние галочки и жмёт одну кнопку.
 * По умолчанию отмечены только совпадения телефона и суммы — остальные видны
 * со своей причиной, но без галочки (решение владельца 20.09.2026).
 */
export function MatchOrdersModal({
  wsId,
  open,
  onClose,
}: {
  wsId: string;
  open: boolean;
  onClose: () => void;
}) {
  const match = useCrmMatch(wsId, open);
  const linkBulk = useLinkCrmDealsBulk(wsId);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<Filter>('confident');

  const items = useMemo(() => match.data?.items ?? [], [match.data]);
  const confidentCount = match.data?.confidentCount ?? 0;

  // Список пришёл — отмечаем надёжные пары. Ручные галочки человека при этом
  // не теряются: эффект срабатывает на смену самого списка, а не на клики.
  useEffect(() => {
    setChecked(new Set(items.filter((i) => i.confident).map((i) => i.deal.id)));
    setFilter(confidentCount > 0 ? 'confident' : 'all');
  }, [items, confidentCount]);

  const shown = filter === 'confident' ? items.filter((i) => i.confident) : items;
  const toggle = (dealId: string, on: boolean) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (on) next.add(dealId);
      else next.delete(dealId);
      return next;
    });

  const submit = () => {
    const pairs = items
      .filter((i) => checked.has(i.deal.id))
      .map((i) => ({ dealId: i.deal.id, orderId: i.order.id }));
    if (pairs.length === 0 || linkBulk.isPending) return;
    linkBulk.mutate(pairs, {
      onSuccess: (r) => {
        const parts = [`Привязано ${plural(r.linked, 'сделка', 'сделки', 'сделок')}`];
        if (r.clientsPatched > 0) {
          parts.push(`дозаполнено карточек клиентов: ${r.clientsPatched}`);
        }
        if (r.skipped > 0) parts.push(`пропущено (уже заняты): ${r.skipped}`);
        toast.success(parts.join(', '));
        onClose();
      },
      onError: (e) => toast.error(e instanceof Error ? e.message : 'Не удалось привязать'),
    });
  };

  return (
    <Modal open={open} onOpenChange={(o) => !o && onClose()}>
      <ModalContent size="2xl" onConfirm={submit}>
        <ModalHeader>
          <ModalTitle>Сопоставить сделки с заказами</ModalTitle>
        </ModalHeader>
        <ModalBody className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Пары подобраны по телефону, сумме, имени клиента и дате. Отмечены только те, где сошлись
            телефон и сумма до копейки. Здесь видны все непривязанные сделки — включая закрытые и
            те, что вне этапов «ждут заказа»: сопоставлять нужно и старые проведённые заказы,
            поэтому пар бывает больше, чем на счётчике раздела. Привязка обратима: «Отвязать» в
            строке сделки. Если у клиента пустой телефон или источник — они дозаполнятся из amoCRM.
          </p>

          {match.isError ? (
            <ErrorState error={match.error} onRetry={() => match.refetch()} />
          ) : match.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              icon={Handshake}
              title="Сопоставлять нечего"
              hint="Все сделки уже привязаны к заказам либо не совпали ни по телефону, ни по сумме. Заведите заказ из сделки кнопкой «Завести заказ»."
            />
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <SegmentedControl
                  value={filter}
                  onChange={setFilter}
                  ariaLabel="Какие пары показывать"
                  options={[
                    { value: 'confident', label: `Надёжные ${confidentCount}` },
                    { value: 'all', label: `Все ${items.length}` },
                  ]}
                />
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Button
                    variant="link"
                    size="sm"
                    onClick={() => setChecked(new Set(shown.map((i) => i.deal.id)))}
                  >
                    Отметить показанные
                  </Button>
                  <Button variant="link" size="sm" onClick={() => setChecked(new Set())}>
                    Снять все
                  </Button>
                </div>
              </div>

              <div className="max-h-[52vh] space-y-2 overflow-y-auto pr-1">
                {shown.map((item) => (
                  <MatchRow
                    key={item.deal.id}
                    item={item}
                    checked={checked.has(item.deal.id)}
                    onToggle={(on) => toggle(item.deal.id, on)}
                  />
                ))}
              </div>
            </>
          )}
        </ModalBody>
        <ModalFooter>
          <ModalClose asChild>
            <Button variant="secondary">Отмена</Button>
          </ModalClose>
          <Button onClick={submit} disabled={checked.size === 0} loading={linkBulk.isPending}>
            Привязать отмеченные ({checked.size})
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

/** Одна пара: слева сделка amo, справа заказ учёта, между ними — причина. */
function MatchRow({
  item,
  checked,
  onToggle,
}: {
  item: CrmMatchItem;
  checked: boolean;
  onToggle: (on: boolean) => void;
}) {
  const reason = REASON[item.reason];
  const sameSum = Number(item.deal.price) === Number(item.order.totalAmount);
  return (
    <div className="rounded-md border border-border p-3">
      <div className="flex items-start gap-3">
        <Checkbox checked={checked} onChange={(e) => onToggle(e.target.checked)} />
        <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium" title={item.deal.name}>
                {item.deal.name}
              </span>
              <a
                href={item.deal.url}
                target="_blank"
                rel="noreferrer"
                className="shrink-0 text-xs text-primary hover:underline"
              >
                amo ↗
              </a>
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              <Money value={item.deal.price} className="text-foreground" /> · {item.deal.statusName}
              {item.deal.phone ? ` · ${item.deal.phone}` : ''}
            </div>
          </div>

          <div className="min-w-0 sm:border-l sm:border-border sm:pl-3">
            <div className="text-sm font-medium">
              {item.order.number}
              {item.order.status === 'DONE' && (
                <span className="ml-2 text-xs font-normal text-muted-foreground">закрыт</span>
              )}
            </div>
            <div className="mt-0.5 truncate text-xs text-muted-foreground">
              <Money value={item.order.totalAmount} className="text-foreground" />
              {item.order.clientName ? ` · ${item.order.clientName}` : ''}
              {item.order.phone ? ` · ${item.order.phone}` : ''}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2 pl-7 text-xs text-muted-foreground">
        <StatusStamp tone={reason.tone} label={reason.label} />
        {!sameSum && (
          <span>
            суммы расходятся на{' '}
            <Money
              value={String(Math.abs(Number(item.deal.price) - Number(item.order.totalAmount)))}
            />
          </span>
        )}
        <span>
          сделка {formatDate(item.deal.remoteCreatedAt)}, заказ {formatDate(item.order.createdAt)}
          {item.daysApart > 0 ? ` · ${plural(item.daysApart, 'день', 'дня', 'дней')} врозь` : ''}
        </span>
      </div>
    </div>
  );
}
