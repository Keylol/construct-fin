'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Calendar, Repeat, Plus, Pencil, Trash2 } from '@/components/ui/icons';
import { formatRub } from '@construct/shared';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { toast } from '@/components/ui/Toaster';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import {
  useRecurring,
  useUpcoming,
  usePlannedList,
  useUpdateRecurring,
  useDeleteRecurring,
} from '@/hooks/usePlanning';
import type { PlannedPayment, RecurringPayment } from '@/lib/types';
import { formatDate } from '@/lib/dates';
import { PayDialog } from '@/components/planning/PayDialog';
import { PlannedDialog } from '@/components/planning/PlannedDialog';
import { RecurringDialog } from '@/components/planning/RecurringDialog';
import { PaidRow, PlannedRow, SummaryCard } from '@/components/planning/PlannedRows';
import { TX_KIND_LABEL, scheduleLabel } from '@/components/planning/shared';

export default function PlanningPage() {
  const { current } = useCurrentWorkspace();
  const wsId = current?.id ?? null;
  const upcoming = useUpcoming(wsId, 60);
  const recurring = useRecurring(wsId);
  const paidList = usePlannedList(wsId, { status: 'PAID' });

  const [recurringDialog, setRecurringDialog] = useState<{
    editing: RecurringPayment | null;
  } | null>(null);
  const [plannedDialog, setPlannedDialog] = useState<{
    mode: 'manual' | 'salary';
    editing: PlannedPayment | null;
  } | null>(null);
  const [payFor, setPayFor] = useState<PlannedPayment | null>(null);

  if (!current) {
    return (
      <>
        <PageHeader title="Платежи" />
        <div className="p-6">
          <EmptyState
            icon={Calendar}
            title="Нет активного пространства"
            hint="Выберите пространство."
          />
        </div>
      </>
    );
  }

  const up = upcoming.data;

  return (
    <>
      <PageHeader
        title="Платежи"
        breadcrumbs={[{ label: 'Платежи' }]}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPlannedDialog({ mode: 'manual', editing: null })}
            >
              <Plus className="h-4 w-4" /> Разовый
            </Button>
            <Button size="sm" onClick={() => setRecurringDialog({ editing: null })}>
              <Repeat className="h-4 w-4" /> Регулярный
            </Button>
          </div>
        }
      />

      <div className="space-y-6 px-6 py-4">
        <p className="max-w-3xl text-sm text-muted-foreground">
          Платёжный календарь: регулярные платежи (аренда, подписки) генерируются
          автоматически, разовые вносятся вручную. Зарплата управляется в разделе{' '}
          <Link href="/salary" className="underline hover:text-foreground">
            «Зарплата»
          </Link>{' '}
          и попадает сюда в общий график. Отметка «Оплатить» создаёт операцию на счёте —
          план связывается с фактом.
        </p>

        {/* Сводка «горит» */}
        {up && (up.overdueCount > 0 || up.soonCount > 0) && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <SummaryCard
              label="Просрочено"
              count={up.overdueCount}
              sum={up.overdueSum}
              tone="destructive"
            />
            <SummaryCard label="Скоро" count={up.soonCount} sum={up.soonSum} tone="warning" />
          </div>
        )}

        {/* Ближайшие платежи */}
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-foreground">Ближайшие платежи</h2>
          {upcoming.isLoading ? (
            <Skeleton className="h-40" />
          ) : !up || up.items.length === 0 ? (
            <EmptyState
              icon={Calendar}
              title="Нет предстоящих платежей"
              hint="Добавьте регулярный или разовый платёж."
            />
          ) : (
            <Card className="divide-y divide-border/60 p-0">
              {up.items.map((p) => (
                <PlannedRow
                  key={p.id}
                  p={p}
                  onPay={() => setPayFor(p)}
                  onEdit={
                    p.source !== 'RECURRING'
                      ? () =>
                          setPlannedDialog({
                            mode: p.source === 'SALARY' ? 'salary' : 'manual',
                            editing: p,
                          })
                      : undefined
                  }
                  wsId={current.id}
                />
              ))}
            </Card>
          )}
        </section>

        {/* Регулярные платежи */}
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-foreground">Регулярные платежи</h2>
          {recurring.isLoading ? (
            <Skeleton className="h-24" />
          ) : (recurring.data?.length ?? 0) === 0 ? (
            <EmptyState
              icon={Repeat}
              title="Пока нет регулярных платежей"
              hint="Аренда, интернет, подписки — добавьте шаблон, и позиции появятся сами."
            />
          ) : (
            <Card className="divide-y divide-border/60 p-0">
              {recurring.data!.map((r) => (
                <RecurringRow
                  key={r.id}
                  r={r}
                  wsId={current.id}
                  onEdit={() => setRecurringDialog({ editing: r })}
                />
              ))}
            </Card>
          )}
        </section>

        {/* Оплаченные — с возможностью отмены (корректировка) */}
        {(paidList.data?.length ?? 0) > 0 && (
          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-muted-foreground">Оплаченные</h2>
            <Card className="divide-y divide-border/60 p-0">
              {paidList.data!.map((p) => (
                <PaidRow key={p.id} p={p} wsId={current.id} />
              ))}
            </Card>
          </section>
        )}
      </div>

      {recurringDialog && (
        <RecurringDialog
          wsId={current.id}
          editing={recurringDialog.editing}
          mode={recurringDialog.editing?.txKind === 'SALARY' ? 'salary' : 'general'}
          onClose={() => setRecurringDialog(null)}
        />
      )}
      {plannedDialog && (
        <PlannedDialog
          wsId={current.id}
          mode={plannedDialog.mode}
          editing={plannedDialog.editing}
          onClose={() => setPlannedDialog(null)}
        />
      )}
      {payFor && <PayDialog wsId={current.id} plan={payFor} onClose={() => setPayFor(null)} />}
    </>
  );
}

function RecurringRow({
  r,
  wsId,
  onEdit,
}: {
  r: RecurringPayment;
  wsId: string;
  onEdit: () => void;
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
    <div className="flex flex-wrap items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{r.title}</span>
          {!r.isActive && (
            <span className="rounded-full bg-secondary px-2 py-0.5 text-[11px] text-muted-foreground">
              пауза
            </span>
          )}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {scheduleLabel(r)} · {TX_KIND_LABEL[r.txKind]}
          {r.nextDueDate && r.isActive && ` · след. ${formatDate(r.nextDueDate)}`}
        </div>
      </div>
      <div className="text-right text-sm font-semibold tabular-nums">{formatRub(r.amount, 2)}</div>
      <div className="flex shrink-0 items-center gap-1">
        <Button variant="ghost" size="sm" onClick={toggleActive} disabled={update.isPending}>
          {r.isActive ? 'Пауза' : 'Включить'}
        </Button>
        <Button variant="ghost" size="sm" onClick={onEdit} aria-label="Править">
          <Pencil className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setConfirmDel(true)} aria-label="Удалить">
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      <ConfirmDialog
        open={confirmDel}
        onOpenChange={setConfirmDel}
        title="Удалить регулярный платёж?"
        description="Будущие ожидаемые позиции этого правила будут отменены. Уже оплаченные останутся."
        confirmText="Удалить"
        onConfirm={async () => {
          await del.mutateAsync(r.id);
          toast.success('Регулярный платёж удалён');
        }}
      />
    </div>
  );
}
