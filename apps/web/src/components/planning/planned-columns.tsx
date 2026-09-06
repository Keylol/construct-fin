'use client';

import { useState } from 'react';
import { Check, Pencil, RotateCcw, Trash2 } from '@/components/ui/icons';
import { Money } from '@/components/ui/Money';
import { Button } from '@/components/ui/Button';
import { StatusDot } from '@/components/ui/StatusDot';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { toast } from '@/components/ui/Toaster';
import type { Column } from '@/components/ui/DataTable';
import {
  useDeleteRecurring,
  useRevertPlanned,
  useSetPlannedStatus,
  useUpdateRecurring,
} from '@/hooks/usePlanning';
import type { PlannedPayment, RecurringPayment } from '@/lib/types';
import { formatDate } from '@/lib/dates';
import { TX_KIND_LABEL, dueLabel, scheduleLabel } from './shared';

/**
 * Колонки платёжного календаря — одни для «Платежей» и «Зарплаты». Раньше
 * каждый экран рисовал строки своими div'ами (PlannedRow/PaidRow/RecurringRow),
 * без мобильных карточек, ошибки загрузки и общих отступов таблицы.
 */

function plannedSubtitle(p: PlannedPayment): string {
  return [
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
}

/** Срок как статус: просрочено — красный, скоро — янтарь, остальное — серое. */
export function DueDot({ p }: { p: PlannedPayment }) {
  return (
    <StatusDot tone={p.overdue ? 'destructive' : p.soon ? 'warning' : 'muted'} label={dueLabel(p)} />
  );
}

/** Действия ожидаемого платежа: оплатить, править, пропустить. Компонент — ради хука. */
export function PlannedActions({
  p,
  wsId,
  onPay,
  onEdit,
}: {
  p: PlannedPayment;
  wsId: string;
  onPay: () => void;
  onEdit?: () => void;
}) {
  const setStatus = useSetPlannedStatus(wsId);
  const skip = () =>
    setStatus.mutate(
      { id: p.id, status: 'SKIPPED' },
      {
        onSuccess: () => toast.success('Платёж пропущен'),
        onError: (e) => toast.error(e instanceof Error ? e.message : 'Ошибка'),
      },
    );
  return (
    <div className="flex items-center justify-end gap-1">
      <Button size="sm" onClick={onPay}>
        <Check className="h-4 w-4" /> Оплатить
      </Button>
      {onEdit && (
        <Button variant="ghost" size="sm" onClick={onEdit} aria-label="Править">
          <Pencil className="h-4 w-4" />
        </Button>
      )}
      <Button variant="ghost" size="sm" onClick={skip} disabled={setStatus.isPending} aria-label="Пропустить">
        ✕
      </Button>
    </div>
  );
}

export function plannedColumns(opts: {
  wsId: string;
  onPay: (p: PlannedPayment) => void;
  onEdit: (p: PlannedPayment) => (() => void) | undefined;
}): Column<PlannedPayment>[] {
  return [
    {
      key: 'due',
      header: 'Срок',
      cell: (p) => <DueDot p={p} />,
      className: 'w-[160px]',
    },
    {
      key: 'title',
      header: 'Платёж',
      className: 'w-full max-w-0',
      cell: (p) => (
        <div className="min-w-0">
          <div className="truncate font-medium">{p.title}</div>
          <div className="truncate text-xs text-muted-foreground">
            {formatDate(p.dueDate)}
            {plannedSubtitle(p) && ` · ${plannedSubtitle(p)}`}
          </div>
        </div>
      ),
    },
    {
      key: 'amount',
      header: 'Сумма',
      align: 'right',
      cell: (p) => <Money value={p.amount} className="font-semibold" />,
      className: 'w-[140px]',
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (p) => <PlannedActions p={p} wsId={opts.wsId} onPay={() => opts.onPay(p)} onEdit={opts.onEdit(p)} />,
      className: 'w-[220px]',
    },
  ];
}

export function plannedMobileCard(p: PlannedPayment, wsId: string, onPay: () => void, onEdit?: () => void) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-medium">{p.title}</span>
        <Money value={p.amount} className="font-semibold" />
      </div>
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="truncate">
          {formatDate(p.dueDate)}
          {plannedSubtitle(p) && ` · ${plannedSubtitle(p)}`}
        </span>
        <DueDot p={p} />
      </div>
      <PlannedActions p={p} wsId={wsId} onPay={onPay} onEdit={onEdit} />
    </div>
  );
}

/** Оплаченный платёж: отмена оплаты (корректировка). */
export function PaidActions({ p, wsId }: { p: PlannedPayment; wsId: string }) {
  const revert = useRevertPlanned(wsId);
  return (
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
  );
}

export function paidColumns(wsId: string): Column<PlannedPayment>[] {
  return [
    {
      key: 'title',
      header: 'Платёж',
      className: 'w-full max-w-0',
      cell: (p) => (
        <div className="min-w-0">
          <div className="truncate">{p.title}</div>
          <div className="truncate text-xs text-muted-foreground">
            {formatDate(p.dueDate)}
            {p.counterpartyName && ` · ${p.counterpartyName}`}
          </div>
        </div>
      ),
    },
    {
      key: 'amount',
      header: 'Сумма',
      align: 'right',
      cell: (p) => <Money value={p.amount} className="text-muted-foreground" tone="plain" />,
      className: 'w-[140px]',
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      hoverOnly: true,
      cell: (p) => <PaidActions p={p} wsId={wsId} />,
      className: 'w-[190px]',
    },
  ];
}

/** Регулярный платёж: пауза/включить, править, удалить (удаление — только в «Платежах»). */
export function RecurringActions({
  r,
  wsId,
  onEdit,
  deletable,
}: {
  r: RecurringPayment;
  wsId: string;
  onEdit: () => void;
  deletable?: boolean;
}) {
  const update = useUpdateRecurring(wsId);
  const del = useDeleteRecurring(wsId);
  const [confirmDel, setConfirmDel] = useState(false);
  const toggleActive = () =>
    update.mutate(
      { id: r.id, isActive: !r.isActive },
      { onError: (e) => toast.error(e instanceof Error ? e.message : 'Ошибка') },
    );
  return (
    <div className="flex items-center justify-end gap-1">
      <Button variant="ghost" size="sm" onClick={toggleActive} disabled={update.isPending}>
        {r.isActive ? 'Пауза' : 'Включить'}
      </Button>
      <Button variant="ghost" size="sm" onClick={onEdit} aria-label="Править">
        <Pencil className="h-4 w-4" />
      </Button>
      {deletable && (
        <>
          <Button variant="ghost" size="sm" onClick={() => setConfirmDel(true)} aria-label="Удалить">
            <Trash2 className="h-4 w-4" />
          </Button>
          <ConfirmDialog
            open={confirmDel}
            onOpenChange={setConfirmDel}
            title="Удалить регулярный платёж?"
            description="Будущие ожидаемые платежи будут отменены. Уже оплаченные останутся."
            confirmText="Удалить"
            onConfirm={async () => {
              await del.mutateAsync(r.id);
              toast.success('Регулярный платёж удалён');
            }}
          />
        </>
      )}
    </div>
  );
}

export function recurringColumns(opts: {
  wsId: string;
  onEdit: (r: RecurringPayment) => void;
  deletable?: boolean;
  /** В «Зарплате» вид платежа всегда один — колонку не показываем. */
  showKind?: boolean;
}): Column<RecurringPayment>[] {
  return [
    {
      key: 'title',
      header: 'Платёж',
      className: 'w-full max-w-0',
      cell: (r) => (
        <div className="min-w-0">
          <div className="truncate font-medium">{r.title}</div>
          <div className="truncate text-xs text-muted-foreground">
            {scheduleLabel(r)}
            {opts.showKind !== false && ` · ${TX_KIND_LABEL[r.txKind]}`}
            {r.counterpartyName && ` · ${r.counterpartyName}`}
            {r.nextDueDate && r.isActive && ` · след. ${formatDate(r.nextDueDate)}`}
          </div>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Статус',
      cell: (r) => <StatusDot tone={r.isActive ? 'success' : 'muted'} label={r.isActive ? 'Активен' : 'Пауза'} />,
      className: 'w-[120px]',
    },
    {
      key: 'amount',
      header: 'Сумма',
      align: 'right',
      cell: (r) => <Money value={r.amount} className="font-semibold" />,
      className: 'w-[140px]',
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (r) => <RecurringActions r={r} wsId={opts.wsId} onEdit={() => opts.onEdit(r)} deletable={opts.deletable} />,
      className: 'w-[200px]',
    },
  ];
}
