'use client';

import { useState } from 'react';
import { Calendar as CalendarCheck, Check } from '@/components/ui/icons';
import { usePlannedSuggestions, usePayPlannedFromLine } from '@/hooks/useInbox';
import type { PlannedLineSuggestion } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { toast } from '@/components/ui/Toaster';
import { formatRub } from '@construct/shared';
import { formatDate } from '@/lib/dates';

/**
 * «Похоже на ожидаемый платёж»: списание из банка совпало по сумме и сроку с
 * платежом из раздела «Платежи». Без гашения планы задваиваются: строка
 * становится обычной проводкой, план продолжает висеть, и его закрывают руками
 * второй раз. Решает человек — ошибочная привязка пометила бы оплаченным чужой
 * план, и настоящий платёж прошёл бы мимо незамеченным.
 */
export function PlannedSuggestions({ wsId }: { wsId: string }) {
  const suggestions = usePlannedSuggestions(wsId);
  const pay = usePayPlannedFromLine(wsId);
  const [hidden, setHidden] = useState<string[]>([]);

  const items = (suggestions.data?.items ?? []).filter(
    (s) => !hidden.includes(`${s.line.id}:${s.plan.id}`),
  );
  if (items.length === 0) return null;

  const accept = (s: PlannedLineSuggestion) => {
    pay.mutate(
      { lineId: s.line.id, plannedPaymentId: s.plan.id },
      {
        onSuccess: () => toast.success(`План «${s.plan.title}» оплачен этой операцией`),
        onError: (e) => toast.error(e instanceof Error ? e.message : 'Не удалось оплатить план'),
      },
    );
  };

  return (
    <div className="mb-4 space-y-2">
      {items.map((s) => (
        <div
          key={`${s.line.id}:${s.plan.id}`}
          className="rounded-md border border-primary/30 bg-primary/5 p-3"
        >
          <div className="mb-2 flex items-center gap-2 text-sm font-medium">
            <CalendarCheck className="h-4 w-4 text-primary" />
            Похоже на ожидаемый платёж «{s.plan.title}»
            <span className="text-xs font-normal text-muted-foreground">
              срок {formatDate(s.plan.dueDate)}
              {s.plan.counterpartyName && ` · ${s.plan.counterpartyName}`}
            </span>
          </div>
          <div className="text-xs text-muted-foreground">
            <span className="text-destructive">−{formatRub(s.line.amount, 2)}</span> ·{' '}
            {s.line.account.name} · {formatDate(s.line.date)}
            {s.line.description && ` · ${s.line.description}`}
          </div>
          <div className="mt-2 flex gap-2">
            <Button size="sm" onClick={() => accept(s)} disabled={pay.isPending}>
              <Check className="h-3.5 w-3.5" />
              Оплатить план этой операцией
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setHidden((prev) => [...prev, `${s.line.id}:${s.plan.id}`])}
            >
              Это не он
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
