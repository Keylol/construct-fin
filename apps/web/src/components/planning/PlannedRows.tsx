'use client';

import { formatRub } from '@construct/shared';
import { Check, Pencil, RotateCcw } from '@/components/ui/icons';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { toast } from '@/components/ui/Toaster';
import { useRevertPlanned, useSetPlannedStatus } from '@/hooks/usePlanning';
import type { PlannedPayment } from '@/lib/types';
import { formatDate } from '@/lib/dates';
import { cn } from '@/lib/cn';
import { dueChipClass, dueLabel } from './shared';

/** Строка ожидаемого платежа: срок-чип, название, сумма, оплата/правка/пропуск. */
export function PlannedRow({
  p,
  onPay,
  onEdit,
  wsId,
}: {
  p: PlannedPayment;
  onPay: () => void;
  onEdit?: () => void;
  wsId: string;
}) {
  const setStatus = useSetPlannedStatus(wsId);
  const subtitle = [
    p.source === 'SALARY' || p.txKind === 'SALARY'
      ? 'Зарплата'
      : p.recurringTitle
        ? 'Регулярный'
        : 'Разовый',
    p.counterpartyName,
    p.categoryName,
  ]
    .filter(Boolean)
    .join(' · ');

  const skip = () =>
    setStatus.mutate(
      { id: p.id, status: 'SKIPPED' },
      {
        onSuccess: () => toast.success('Платёж пропущен'),
        onError: (e) => toast.error(e instanceof Error ? e.message : 'Ошибка'),
      },
    );

  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3">
      <span
        className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium', dueChipClass(p))}
      >
        {dueLabel(p)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">{p.title}</div>
        <div className="truncate text-xs text-muted-foreground">
          {formatDate(p.dueDate)}
          {subtitle && ` · ${subtitle}`}
        </div>
      </div>
      <div className="text-right text-sm font-semibold tabular-nums">{formatRub(p.amount, 2)}</div>
      <div className="flex shrink-0 items-center gap-1">
        <Button size="sm" onClick={onPay}>
          <Check className="h-4 w-4" /> Оплатить
        </Button>
        {onEdit && (
          <Button variant="ghost" size="sm" onClick={onEdit} aria-label="Править">
            <Pencil className="h-4 w-4" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={skip}
          disabled={setStatus.isPending}
          aria-label="Пропустить"
        >
          ✕
        </Button>
      </div>
    </div>
  );
}

/** Строка оплаченного платежа с отменой оплаты (корректировка). */
export function PaidRow({ p, wsId }: { p: PlannedPayment; wsId: string }) {
  const revert = useRevertPlanned(wsId);
  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-foreground">{p.title}</div>
        <div className="truncate text-xs text-muted-foreground">
          {formatDate(p.dueDate)}
          {p.counterpartyName && ` · ${p.counterpartyName}`}
        </div>
      </div>
      <div className="text-right text-sm tabular-nums text-muted-foreground">
        {formatRub(p.amount, 2)}
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={() =>
          revert.mutate(p.id, {
            onSuccess: () => toast.success('Оплата отменена'),
            onError: (e) => toast.error(e instanceof Error ? e.message : 'Ошибка'),
          })
        }
        disabled={revert.isPending}
      >
        <RotateCcw className="h-4 w-4" /> Отменить оплату
      </Button>
    </div>
  );
}

/** Сводная карточка «Просрочено/Скоро» (счётчик + сумма). */
export function SummaryCard({
  label,
  count,
  sum,
  tone,
}: {
  label: string;
  count: number;
  sum: string;
  tone: 'destructive' | 'warning';
}) {
  return (
    <Card
      className={cn(
        'flex items-center justify-between p-4',
        tone === 'destructive' ? 'border-destructive/30' : 'border-warning/30',
      )}
    >
      <div>
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="text-sm text-muted-foreground">{count} платеж(ей)</div>
      </div>
      <div
        className={cn(
          'text-xl font-semibold tabular-nums',
          tone === 'destructive' ? 'text-destructive' : 'text-warning',
        )}
      >
        {formatRub(sum, 2)}
      </div>
    </Card>
  );
}
