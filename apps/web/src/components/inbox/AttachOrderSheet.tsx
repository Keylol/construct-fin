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
import { attachEffect, formatRub, parseAcquiringFee, D, sub, toMoneyString } from '@construct/shared';
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
  // Переплату подтверждают явно: строку больше остатка система принимает молча,
  // и чужой платёж уже прицеплялся к заказу (Савтиков) — вскрылось при сверке.
  const [overpayOk, setOverpayOk] = useState(false);

  // Торговое возмещение зачисляется за вычетом комиссии банка. Заказ закроется
  // на брутто, комиссия уйдёт отдельным расходом — предупреждаем заранее, иначе
  // сумма в заказе не совпадёт с суммой строки и это выглядит как ошибка.
  const fee = parseAcquiringFee(line.description);

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

  // Остаток выбранного заказа и то, что с ним сделает привязка. base считается
  // без галки: с ней недобора не остаётся, и предложение рассрочки исчезло бы
  // сразу после включения.
  const remaining = selected ? toMoneyString(sub(selected.totalAmount, selected.paidAmount)) : null;
  const base = remaining
    ? attachEffect({ lineAmount: line.amount, description: line.description, remaining })
    : null;
  const applied = remaining
    ? attachEffect({
        lineAmount: line.amount,
        description: line.description,
        remaining,
        installment,
      })
    : null;
  const shortfall = base && D(base.shortfall).gt(0) ? base.shortfall : null;
  // Эквайринг и рассрочка — два способа учесть одно и то же удержание; вместе
  // они дали бы двойной расход, поэтому предлагаем рассрочку только без него.
  const canInstallment = !!base?.canInstallment;
  const overpay = applied && D(applied.overpay).gt(0) ? applied.overpay : null;

  useEffect(() => {
    if (!canInstallment) setInstallment(false);
  }, [canInstallment]);
  // Подтверждение переплаты привязано к конкретному заказу: сменил заказ —
  // подтверждай заново.
  useEffect(() => setOverpayOk(false), [orderId]);

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
          {base && fee ? (
            <div className="rounded-md border border-border bg-background p-3 text-xs text-muted-foreground">
              Банк удержал комиссию <span className="font-semibold text-foreground">{formatRub(fee, 2)}</span>{' '}
              внутри этого возмещения. В заказ зачтётся{' '}
              <span className="font-semibold text-foreground">{formatRub(base.credited, 2)}</span>, комиссия пройдёт
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

          {/* Остаток и зачёт видны всегда: решение «моя это строка или нет»
              принимается по ним, а не по сумме в заголовке. */}
          {remaining && applied && (
            <div className="rounded-md border border-border p-3 text-xs text-muted-foreground">
              Остаток по заказу{' '}
              <span className="font-semibold text-foreground">{formatRub(remaining, 2)}</span> → зачтётся{' '}
              <span className="font-semibold text-foreground">{formatRub(applied.credited, 2)}</span>
            </div>
          )}

          {overpay && (
            <div className="space-y-1 rounded-md border border-warning/40 bg-warning/10 p-3">
              <p className="text-sm font-semibold text-foreground">
                Будет переплата {formatRub(overpay, 2)}
              </p>
              <p className="text-xs text-muted-foreground">
                Строка больше остатка по заказу. Обычно это платёж другого клиента или другого
                заказа — проверьте назначение и сумму. Если деньги действительно пришли сверх
                остатка (аванс на следующий заказ), подтвердите.
              </p>
              <label className="flex items-start gap-2 pt-1 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={overpayOk}
                  onChange={(e) => setOverpayOk(e.target.checked)}
                />
                <span>Всё верно, привязать с переплатой</span>
              </label>
            </div>
          )}

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
          <Button
            onClick={submit}
            disabled={!orderId || attach.isPending || (!!overpay && !overpayOk)}
          >
            {installment ? 'Провести кредит' : 'Привязать поступление'}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
