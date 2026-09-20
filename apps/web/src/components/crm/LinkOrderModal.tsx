'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { Money } from '@/components/ui/Money';
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
import { useLinkCrmDeal } from '@/hooks/useCrm';
import { useOrders } from '@/hooks/useOrders';
import type { CrmDeal } from '@/lib/types';

/**
 * Привязать сделку к уже существующему заказу. Кандидаты по телефону стоят
 * первыми и подставляются сразу — обычно нужный заказ один.
 */
export function LinkOrderModal({
  wsId,
  deal,
  onClose,
}: {
  wsId: string;
  deal: CrmDeal | null;
  onClose: () => void;
}) {
  const open = deal !== null;
  // Без фильтра статуса: сопоставлять приходится прежде всего со СТАРЫМИ
  // заказами, а они закрыты (на проде 63 из 94). С `status: 'OPEN'` окно их не
  // показывало, и привязать сделку к проведённому заказу было нельзя.
  const orders = useOrders(wsId, { limit: 200 });
  const link = useLinkCrmDeal(wsId);
  const [orderId, setOrderId] = useState('');

  useEffect(() => {
    if (!deal) return;
    setOrderId(deal.suggestedOrders[0]?.id ?? '');
  }, [deal]);

  const options = useMemo<ComboboxOption[]>(() => {
    const suggested = new Set((deal?.suggestedOrders ?? []).map((o) => o.id));
    const list = (orders.data?.pages ?? []).flatMap((p) => p.items);
    const known = new Set(list.map((o) => o.id));
    // Кандидаты по телефону могут быть вне первой сотни открытых — показываем
    // их всё равно, из ответа сделки.
    const extra = (deal?.suggestedOrders ?? []).filter((o) => !known.has(o.id));
    return [
      ...extra.map((o) => ({
        value: o.id,
        label: `${o.number}${o.phone ? ` · ${o.phone}` : ''}`,
        group: 'Похоже на эту сделку',
      })),
      ...list.map((o) => ({
        value: o.id,
        label: `${o.number}${o.client ? ` · ${o.client.name}` : ''}${o.phone ? ` · ${o.phone}` : ''}`,
        description:
          o.status === 'DONE' ? 'закрыт' : o.status === 'CANCELLED' ? 'отменён' : undefined,
        group: suggested.has(o.id)
          ? 'Похоже на эту сделку'
          : o.status === 'OPEN'
            ? 'Открытые заказы'
            : 'Закрытые заказы',
      })),
    ];
  }, [orders.data, deal]);

  const submit = () => {
    if (!deal || !orderId || link.isPending) return;
    link.mutate(
      { dealId: deal.id, orderId },
      {
        onSuccess: () => {
          toast.success('Сделка привязана к заказу');
          onClose();
        },
        onError: (e) => toast.error(e instanceof Error ? e.message : 'Не удалось привязать'),
      },
    );
  };

  return (
    <Modal open={open} onOpenChange={(o) => !o && onClose()}>
      <ModalContent size="md" onConfirm={submit}>
        <ModalHeader>
          <ModalTitle>Привязать сделку к заказу</ModalTitle>
        </ModalHeader>
        <ModalBody className="space-y-4">
          {deal && (
            <div className="rounded-md bg-secondary/40 p-3 text-sm">
              <div className="font-medium">{deal.name}</div>
              <div className="text-xs text-muted-foreground">
                {deal.statusName} · бюджет <Money value={deal.price} className="text-foreground" />
                {deal.phone ? ` · ${deal.phone}` : ''}
              </div>
            </div>
          )}
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            <span>Заказ</span>
            <Combobox
              value={orderId}
              onChange={setOrderId}
              options={options}
              placeholder="Выберите заказ"
              searchPlaceholder="Номер, клиент или телефон…"
              loading={orders.isLoading}
              className="h-9"
            />
          </label>
        </ModalBody>
        <ModalFooter>
          <ModalClose asChild>
            <Button variant="secondary">Отмена</Button>
          </ModalClose>
          <Button onClick={submit} disabled={!orderId} loading={link.isPending}>
            Привязать
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
