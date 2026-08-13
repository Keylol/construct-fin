'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowRight } from '@/components/ui/icons';
import { useOrders } from '@/hooks/useOrders';
import { useAttachOrderInbox } from '@/hooks/useInbox';
import type { InboxLine, Order } from '@/lib/types';
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
import { formatRub, parseAcquiringFee, D, sub, toMoneyString } from '@construct/shared';
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
  // Кредит/рассрочка: банк присылает сумму за вычетом комиссии, и без этого
  // заказ остаётся недоплаченным ровно на неё (4 случая из 21 заказа за июль).
  const [installment, setInstallment] = useState(false);

  // Торговое возмещение зачисляется за вычетом комиссии банка. Заказ закроется
  // на брутто, комиссия уйдёт отдельным расходом — предупреждаем заранее, иначе
  // сумма в заказе не совпадёт с суммой строки и это выглядит как ошибка.
  const fee = parseAcquiringFee(line.description);
  const gross = fee ? (Number(line.amount) + Number(fee)).toFixed(2) : null;

  const openOrders = useMemo(
    () => orders.data?.pages.flatMap((p) => p.items) ?? [],
    [orders.data],
  );
  const selected: Order | undefined = openOrders.find((o) => o.id === orderId);

  const orderOptions = useMemo<ComboboxOption[]>(
    () =>
      openOrders.map((o) => ({
        value: o.id,
        label: `${o.number}${o.client ? ` · ${o.client.name}` : ''}`,
        description: `Заказ ${formatRub(o.totalAmount)} · оплачено ${formatRub(o.paidAmount)}`,
      })),
    [openOrders],
  );

  // Остаток выбранного заказа и комиссия банка как разница с суммой строки.
  const remaining = selected ? toMoneyString(sub(selected.totalAmount, selected.paidAmount)) : null;
  const shortfall =
    remaining && D(remaining).gt(D(line.amount)) ? toMoneyString(sub(remaining, line.amount)) : null;
  // Эквайринг и рассрочка — два способа учесть одно и то же удержание; вместе
  // они дали бы двойной расход, поэтому предлагаем рассрочку только без него.
  const canInstallment = !fee && !!shortfall;

  useEffect(() => {
    if (!canInstallment) setInstallment(false);
  }, [canInstallment]);

  const submit = () => {
    if (!orderId) return;
    attach.mutate(
      {
        lineId: line.id,
        orderId,
        ...(installment && remaining && shortfall
          ? { installment: { amount: remaining, fee: shortfall } }
          : {}),
      },
      {
        onSuccess: () => {
          toast.success(
            installment ? 'Кредит проведён: заказ закрыт, комиссия — расходом' : 'Поступление привязано к заказу',
          );
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

          {canInstallment && remaining && shortfall && (
            <div className="space-y-1 rounded-md border border-border p-3">
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={installment}
                  onChange={(e) => setInstallment(e.target.checked)}
                />
                <span>Кредит или рассрочка</span>
              </label>
              <p className="text-xs text-muted-foreground">
                Строка меньше остатка заказа на{' '}
                <span className="font-semibold text-foreground">{formatRub(shortfall, 2)}</span>. С
                галкой в заказ зачтётся{' '}
                <span className="font-semibold text-foreground">{formatRub(remaining, 2)}</span>, а
                разница пройдёт расходом «Комиссия рассрочки» — заказ закроется, на счёт сядет ровно{' '}
                {formatRub(line.amount, 2)}. Без галки заказ останется недоплаченным.
              </p>
            </div>
          )}

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
            {installment ? 'Провести кредит' : 'Привязать поступление'}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
