'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowRight } from '@/components/ui/icons';
import { useOrders } from '@/hooks/useOrders';
import { useAttachOrderInbox } from '@/hooks/useInbox';
import type { InboxLine } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { toast } from '@/components/ui/Toaster';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/Sheet';
import { formatRub, parseAcquiringFee } from '@construct/shared';
import { formatDate } from '@/lib/dates';

/** Поступление из банка → оплата открытого заказа (пересчёт paidAmount внутри). */
export function AttachOrderSheet({
  open,
  onClose,
  wsId,
  line,
}: {
  open: boolean;
  onClose: () => void;
  wsId: string;
  line: InboxLine;
}) {
  const orders = useOrders(wsId, { status: 'OPEN', limit: 100 });
  const attach = useAttachOrderInbox(wsId);
  const [orderId, setOrderId] = useState('');

  // Торговое возмещение зачисляется за вычетом комиссии банка. Заказ закроется
  // на брутто, комиссия уйдёт отдельным расходом — предупреждаем заранее, иначе
  // сумма в заказе не совпадёт с суммой строки и это выглядит как ошибка.
  const fee = parseAcquiringFee(line.description);
  const gross = fee ? (Number(line.amount) + Number(fee)).toFixed(2) : null;

  const orderOptions = useMemo<ComboboxOption[]>(
    () =>
      (orders.data?.pages.flatMap((p) => p.items) ?? []).map((o) => ({
        value: o.id,
        label: `${o.number}${o.client ? ` · ${o.client.name}` : ''}`,
        description: `Заказ ${formatRub(o.totalAmount)} · оплачено ${formatRub(o.paidAmount)}`,
      })),
    [orders.data],
  );

  const submit = () => {
    if (!orderId) return;
    attach.mutate(
      { lineId: line.id, orderId },
      {
        onSuccess: () => {
          toast.success('Поступление привязано к заказу');
          onClose();
        },
        onError: (e) => toast.error(e instanceof Error ? e.message : 'Не удалось привязать'),
      },
    );
  };

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-[420px]">
        <SheetHeader>
          <SheetTitle>Привязать поступление к заказу</SheetTitle>
        </SheetHeader>
        <SheetBody className="space-y-4">
          <div className="rounded-md bg-secondary/40 p-3 text-sm">
            Поступление{' '}
            <span className="font-semibold text-success">+{formatRub(line.amount, 2)}</span>{' '}
            от {formatDate(line.date)}
            {line.counterpartyName ? ` · ${line.counterpartyName}` : ''}
          </div>
          {gross && fee ? (
            <div className="rounded-md border border-border bg-background p-3 text-xs text-muted-foreground">
              Банк удержал комиссию <span className="font-semibold text-foreground">{formatRub(fee, 2)}</span>{' '}
              внутри этого возмещения. В заказ зачтётся{' '}
              <span className="font-semibold text-foreground">{formatRub(gross, 2)}</span>, комиссия пройдёт
              расходом «Банковские услуги» той же датой — остаток по счёту не изменится.
            </div>
          ) : null}
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            <span>Открытый заказ</span>
            <Combobox
              value={orderId}
              onChange={setOrderId}
              options={orderOptions}
              placeholder="Выберите заказ"
              searchPlaceholder="Номер или клиент…"
              className="h-9"
            />
          </label>
          <p className="text-xs text-muted-foreground">
            Нет подходящего заказа?{' '}
            <Link href={'/orders?new=1' as Parameters<typeof Link>[0]['href']} className="text-primary hover:underline">
              создать заказ <ArrowRight className="inline h-3 w-3" />
            </Link>
          </p>
        </SheetBody>
        <SheetFooter>
          <Button variant="secondary" onClick={onClose}>
            Отмена
          </Button>
          <Button onClick={submit} disabled={!orderId || attach.isPending}>
            Привязать поступление
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
