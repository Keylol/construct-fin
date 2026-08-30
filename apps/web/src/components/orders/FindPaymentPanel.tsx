'use client';

import { useEffect, useMemo, useState } from 'react';
import { attachEffect, formatRub, rankPaymentCandidates, sub, toMoneyString, D } from '@construct/shared';
import { useInbox, useAttachOrderInbox } from '@/hooks/useInbox';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { toast } from '@/components/ui/Toaster';
import { formatDate } from '@/lib/dates';
import type { Order } from '@/lib/types';

/** Сколько кандидатов показываем: дальше первых строк список уже не читают. */
const VISIBLE = 8;

/**
 * «Найти оплату» — подбор строки выписки под открытый заказ.
 *
 * Без этого сотрудник упирается в главный тупик ручной работы: во «Входящих»
 * сотни строк, а поиск по сумме клиента при торговом эквайринге не находит
 * ничего (банк зачисляет нетто). Кандидаты ранжируются чистой функцией из
 * @construct/shared; привязка идёт через тот же attach-order, что и во
 * «Входящих» — он сам расщепляет удержанную комиссию.
 */
export function FindPaymentPanel({
  wsId,
  order,
  onClose,
}: {
  wsId: string;
  order: Order;
  onClose: () => void;
}) {
  // Приходы на разборе: строк бывает больше страницы, а нужная легко окажется
  // в хвосте — дотягиваем список целиком, иначе подсказка врёт «ничего нет».
  const inbox = useInbox(wsId, 'NEW', { direction: 'INCOME' });
  const attach = useAttachOrderInbox(wsId);
  // Строку дороже остатка привязываем только после подтверждения: подсказка
  // ранжирует и по имени клиента, а тёзка с другим заказом даст переплату.
  const [confirmOverpay, setConfirmOverpay] = useState<{ lineId: string; overpay: string } | null>(
    null,
  );

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = inbox;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const remaining = toMoneyString(sub(order.totalAmount, order.paidAmount));

  const ranked = useMemo(() => {
    const lines = inbox.data?.pages.flatMap((p) => p.items) ?? [];
    return rankPaymentCandidates(lines, {
      remaining,
      clientName: order.client?.name ?? null,
      title: order.title ?? null,
    });
  }, [inbox.data, remaining, order.client?.name, order.title]);

  const link = (lineId: string) =>
    attach.mutate(
      { lineId, orderId: order.id },
      {
        onSuccess: () => {
          toast.success('Поступление привязано к заказу');
          onClose();
        },
        onError: (e) => toast.error(e instanceof Error ? e.message : 'Не удалось привязать'),
      },
    );

  const loading = inbox.isLoading || hasNextPage;

  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">Кандидаты на оплату</span>
        <span className="text-xs text-muted-foreground">остаток {formatRub(remaining)}</span>
      </div>

      {loading ? (
        <p className="text-xs text-muted-foreground">Смотрим строки на разборе…</p>
      ) : ranked.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Подходящих строк не нашлось: ни по сумме остатка, ни по клиенту, ни по названию заказа.
          Возможно, деньги ещё не пришли или строка уже разобрана.
        </p>
      ) : (
        <ul className="space-y-2">
          {ranked.slice(0, VISIBLE).map(({ line, reasons }) => {
            const effect = attachEffect({
              lineAmount: line.amount,
              description: line.description,
              remaining,
            });
            const overpay = D(effect.overpay).gt(0) ? effect.overpay : null;
            return (
              <li key={line.id} className="space-y-1 rounded-md bg-secondary/40 p-2.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-semibold tabular-nums text-success">
                    +{formatRub(line.amount)}
                  </span>
                  <span className="text-xs text-muted-foreground">{formatDate(line.date)}</span>
                </div>
                {line.counterpartyName && (
                  <p className="text-xs text-muted-foreground">{line.counterpartyName}</p>
                )}
                {line.description && (
                  <p className="line-clamp-2 text-xs text-muted-foreground">{line.description}</p>
                )}
                <p className="text-xs text-primary">{reasons.join(' · ')}</p>
                {overpay && (
                  <p className="text-xs text-warning">переплата {formatRub(overpay)}</p>
                )}
                <Button
                  size="sm"
                  onClick={() =>
                    overpay ? setConfirmOverpay({ lineId: line.id, overpay }) : link(line.id)
                  }
                  disabled={attach.isPending}
                >
                  Привязать
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      {ranked.length > VISIBLE && (
        <p className="text-xs text-muted-foreground">
          Показаны {VISIBLE} из {ranked.length} — уточните остаток или ищите во «Входящих».
        </p>
      )}

      <ConfirmDialog
        open={!!confirmOverpay}
        onOpenChange={(o) => !o && setConfirmOverpay(null)}
        title="Строка больше остатка"
        variant="primary"
        confirmText="Привязать с переплатой"
        description={
          confirmOverpay
            ? `Заказ получит переплату ${formatRub(confirmOverpay.overpay)}: остаток по нему — ${formatRub(remaining)}. Обычно это платёж другого клиента или другого заказа — проверьте назначение.`
            : ''
        }
        onConfirm={async () => {
          if (confirmOverpay) link(confirmOverpay.lineId);
          setConfirmOverpay(null);
        }}
        loading={attach.isPending}
      />
    </div>
  );
}
