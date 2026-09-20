'use client';

import { useState } from 'react';
import { Handshake } from '@/components/ui/icons';
import { Button } from '@/components/ui/Button';
import { Money } from '@/components/ui/Money';
import { toast } from '@/components/ui/Toaster';
import { formatDate } from '@/lib/dates';
import { useCrmInboxSuggestions, useCreateOrderFromDeal } from '@/hooks/useCrm';
import { useAttachOrderInbox } from '@/hooks/useInbox';
import type { CrmInboxSuggestion } from '@/lib/types';

/**
 * «Этот приход — по сделке amoCRM»: сумма платежа сошлась с бюджетом сделки.
 * Банк приносит копейки, amo хранит целые рубли, поэтому платёж 150 198,25 и
 * сделка на 150 198 — одна продажа; допуск ровно рубль.
 *
 * Ничего не проводится само: видно, чей это платёж, а дальше человек либо
 * засчитывает его в уже заведённый заказ, либо одной кнопкой заводит заказ из
 * сделки и сразу засчитывает оплату.
 */
export function CrmDealSuggestions({ wsId }: { wsId: string }) {
  const suggestions = useCrmInboxSuggestions(wsId);
  const createOrder = useCreateOrderFromDeal(wsId);
  const attach = useAttachOrderInbox(wsId);
  const [hidden, setHidden] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const items = (suggestions.data?.items ?? []).filter((s) => !hidden.includes(s.line.id));
  if (items.length === 0) return null;

  /** Зачесть платёж в уже существующий заказ сделки. */
  const credit = (s: CrmInboxSuggestion, orderId: string, orderNumber: string) => {
    setBusy(s.line.id);
    attach.mutate(
      { lineId: s.line.id, orderId },
      {
        onSuccess: () => toast.success(`Поступление зачтено в заказ ${orderNumber}`),
        onError: (e) => toast.error(e instanceof Error ? e.message : 'Не удалось зачесть'),
        onSettled: () => setBusy(null),
      },
    );
  };

  /** Завести заказ из сделки и сразу зачесть в него этот платёж. */
  const createAndCredit = (s: CrmInboxSuggestion) => {
    setBusy(s.line.id);
    createOrder.mutate(s.deal.id, {
      onSuccess: (r) =>
        attach.mutate(
          { lineId: s.line.id, orderId: r.orderId },
          {
            onSuccess: () => toast.success(`Заказ ${r.orderNumber} заведён, поступление зачтено`),
            // Заказ уже создан — говорим об этом прямо, чтобы человек не
            // заводил второй, а просто привязал деньги в строке.
            onError: (e) =>
              toast.error(
                `Заказ ${r.orderNumber} заведён, но зачесть оплату не вышло: ${
                  e instanceof Error ? e.message : 'ошибка'
                }`,
              ),
            onSettled: () => setBusy(null),
          },
        ),
      onError: (e) => {
        toast.error(e instanceof Error ? e.message : 'Не удалось завести заказ');
        setBusy(null);
      },
    });
  };

  return (
    <div className="mb-4 space-y-2">
      {items.map((s) => (
        <div key={s.line.id} className="rounded-md border border-primary/30 bg-primary/5 p-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 text-sm">
              <div className="flex items-center gap-2">
                <Handshake className="h-4 w-4 shrink-0 text-primary" />
                <span className="font-medium">Похоже на сделку amoCRM</span>
              </div>
              <div className="mt-1 text-muted-foreground">
                Приход <Money value={s.line.amount} className="text-foreground" /> от{' '}
                {formatDate(s.line.date)} — сделка{' '}
                <a
                  href={s.deal.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary hover:underline"
                >
                  {s.deal.name}
                </a>{' '}
                на <Money value={s.deal.price} className="text-foreground" />
                {s.diff > 0 && <> (в amo сумма округлена, разница {s.diff.toFixed(2)} ₽)</>}
                {s.deal.contactName ? ` · ${s.deal.contactName}` : ''}
              </div>
              {s.order && (
                <div className="mt-0.5 text-xs text-muted-foreground">
                  Заказ {s.order.number}: оплачено <Money value={s.order.paidAmount} /> из{' '}
                  <Money value={s.order.totalAmount} />
                </div>
              )}
              {!s.order && !s.deal.phone && (
                <div className="mt-0.5 text-xs text-warning">
                  У сделки нет телефона — заказ по ней заводится только вручную.
                </div>
              )}
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {s.order ? (
                <Button
                  size="sm"
                  onClick={() => credit(s, s.order!.id, s.order!.number)}
                  loading={busy === s.line.id}
                >
                  Зачесть в {s.order.number}
                </Button>
              ) : (
                <Button
                  size="sm"
                  onClick={() => createAndCredit(s)}
                  disabled={!s.deal.phone}
                  loading={busy === s.line.id}
                  title={s.deal.phone ? undefined : 'В сделке нет телефона — добавьте его в amoCRM'}
                >
                  Завести заказ и зачесть
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={() => setHidden((p) => [...p, s.line.id])}>
                Скрыть
              </Button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
