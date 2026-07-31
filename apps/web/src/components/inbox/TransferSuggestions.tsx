'use client';

import { useState } from 'react';
import { ArrowRight, Check } from '@/components/ui/icons';
import { useTransferCandidates, useConfirmTransfer } from '@/hooks/useInbox';
import type { TransferCandidate } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { toast } from '@/components/ui/Toaster';
import { formatRub } from '@construct/shared';
import { formatDate } from '@/lib/dates';

/**
 * «Похоже на перевод»: расход на одном счёте и приход на другом, которые
 * выглядят как две стороны одного перемещения денег. Разобранные порознь, они
 * задвоят обороты — покажут расход и доход там, где деньги из бизнеса не
 * выходили. Автоматически не склеиваем: ложная склейка спрячет настоящую
 * операцию, поэтому решает человек.
 */
export function TransferSuggestions({ wsId }: { wsId: string }) {
  const candidates = useTransferCandidates(wsId);
  const confirm = useConfirmTransfer(wsId);
  const [hidden, setHidden] = useState<string[]>([]);

  const items = (candidates.data?.items ?? []).filter(
    (c) => !hidden.includes(`${c.out.id}:${c.in.id}`),
  );
  if (items.length === 0) return null;

  const accept = (c: TransferCandidate) => {
    confirm.mutate(
      { outLineId: c.out.id, inLineId: c.in.id },
      {
        onSuccess: () =>
          toast.success(
            Number(c.fee) > 0
              ? `Перевод создан, комиссия ${formatRub(c.fee, 2)} учтена расходом`
              : 'Перевод создан — суммы не попадут в обороты дважды',
          ),
        onError: (e) => toast.error(e instanceof Error ? e.message : 'Не удалось создать перевод'),
      },
    );
  };

  return (
    <div className="mb-4 space-y-2">
      {items.map((c) => (
        <div
          key={`${c.out.id}:${c.in.id}`}
          className="rounded-md border border-primary/30 bg-primary/5 p-3"
        >
          <div className="mb-2 flex items-center gap-2 text-sm font-medium">
            <ArrowRight className="h-4 w-4 text-primary" />
            Похоже на перевод между своими счетами
            {c.confidence === 'with_fee' && (
              <span className="text-xs font-normal text-muted-foreground">
                — суммы разошлись на {formatRub(c.fee, 2)}, спишем как комиссию
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>
              <span className="text-destructive">−{formatRub(c.out.amount, 2)}</span> ·{' '}
              {c.out.account.name} · {formatDate(c.out.date)}
            </span>
            <ArrowRight className="h-3 w-3" />
            <span>
              <span className="text-success">+{formatRub(c.in.amount, 2)}</span> ·{' '}
              {c.in.account.name} · {formatDate(c.in.date)}
            </span>
          </div>
          <div className="mt-2 flex gap-2">
            <Button size="sm" onClick={() => accept(c)} disabled={confirm.isPending}>
              <Check className="h-3.5 w-3.5" />
              Это перевод
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setHidden((prev) => [...prev, `${c.out.id}:${c.in.id}`])}
            >
              Не перевод
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
