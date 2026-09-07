'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Calendar, Repeat, Plus } from '@/components/ui/icons';
import { Money } from '@/components/ui/Money';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useRecurring, useUpcoming, usePlannedList } from '@/hooks/usePlanning';
import type { PlannedPayment, RecurringPayment } from '@/lib/types';
import { formatDate } from '@/lib/dates';
import { ForecastCard } from '@/components/planning/ForecastCard';
import { PayDialog } from '@/components/planning/PayDialog';
import { PlannedDialog } from '@/components/planning/PlannedDialog';
import { RecurringDialog } from '@/components/planning/RecurringDialog';
import {
  PaidActions,
  RecurringActions,
  paidColumns,
  plannedColumns,
  plannedMobileCard,
  recurringColumns,
} from '@/components/planning/planned-columns';
import { TX_KIND_LABEL, scheduleLabel } from '@/components/planning/shared';
import { DataTable } from '@/components/ui/DataTable';
import { KpiCard } from '@/components/ui/KpiCard';
import { KpiRow } from '@/components/ui/KpiRow';
import { plural } from '@/lib/plural';

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

  if (!current) return null;

  const up = upcoming.data;

  const editPlanned = (p: PlannedPayment) =>
    p.source !== 'RECURRING'
      ? () => setPlannedDialog({ mode: p.source === 'SALARY' ? 'salary' : 'manual', editing: p })
      : undefined;
  const plannedCols = plannedColumns({ wsId: current.id, onPay: setPayFor, onEdit: editPlanned });
  const recurringCols = recurringColumns({
    wsId: current.id,
    onEdit: (r) => setRecurringDialog({ editing: r }),
    deletable: true,
  });
  const paidCols = paidColumns(current.id);

  return (
    <>
      <PageHeader
        title="Платежи"
        description={
          <>
            Платёжный календарь: регулярные платежи (аренда, подписки) генерируются
            автоматически, разовые вносятся вручную. Зарплата управляется в разделе{' '}
            <Link href="/salary" className="underline hover:text-foreground">
              «Зарплата»
            </Link>{' '}
            и попадает сюда в общий график. Отметка «Оплатить» создаёт операцию на счёте —
            план связывается с фактом.
          </>
        }
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

        {/* Прогноз остатка: кассовый разрыв виден заранее. */}
        <ForecastCard wsId={current.id} />

        {/* Сводка «горит» */}
        {up && (up.overdueCount > 0 || up.soonCount > 0) && (
          <KpiRow count={2}>
            <KpiCard
              label="Просрочено"
              value={<Money value={up.overdueSum} tone="plain" />}
              tone="negative"
              hint={`${up.overdueCount} ${plural(up.overdueCount, 'платёж', 'платежа', 'платежей')}`}
            />
            <KpiCard
              label="Скоро"
              value={<Money value={up.soonSum} tone="plain" />}
              tone="warning"
              hint={`${up.soonCount} ${plural(up.soonCount, 'платёж', 'платежа', 'платежей')}`}
            />
          </KpiRow>
        )}

        {/* Ближайшие платежи */}
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-foreground">Ближайшие платежи</h2>
          <div className="rounded-md border border-border bg-card">
            <DataTable
              data={up?.items ?? []}
              columns={plannedCols}
              rowKey={(p) => p.id}
              loading={upcoming.isLoading}
              error={upcoming.error}
              onRetry={() => upcoming.refetch()}
              empty={
                <EmptyState
                  icon={Calendar}
                  title="Нет предстоящих платежей"
                  hint="Добавьте регулярный или разовый платёж."
                />
              }
              mobileCards={(p) =>
                plannedMobileCard(p, current.id, () => setPayFor(p), editPlanned(p))
              }
            />
          </div>
        </section>

        {/* Регулярные платежи */}
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-foreground">Регулярные платежи</h2>
          <div className="rounded-md border border-border bg-card">
            <DataTable
              data={recurring.data ?? []}
              columns={recurringCols}
              rowKey={(r) => r.id}
              loading={recurring.isLoading}
              error={recurring.error}
              onRetry={() => recurring.refetch()}
              empty={
                <EmptyState
                  icon={Repeat}
                  title="Пока нет регулярных платежей"
                  hint="Аренда, интернет, подписки — добавьте регулярный платёж, и ожидаемые платежи появятся сами."
                />
              }
              mobileCards={(r) => (
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium">{r.title}</span>
                    <Money value={r.amount} className="font-semibold" />
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {scheduleLabel(r)} · {TX_KIND_LABEL[r.txKind]}
                  </div>
                  <RecurringActions r={r} wsId={current.id} onEdit={() => setRecurringDialog({ editing: r })} deletable />
                </div>
              )}
            />
          </div>
        </section>

        {/* Оплаченные — с возможностью отмены (корректировка) */}
        {(paidList.data?.length ?? 0) > 0 && (
          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-muted-foreground">Оплаченные</h2>
            <div className="rounded-md border border-border bg-card">
              <DataTable
                data={paidList.data ?? []}
                columns={paidCols}
                rowKey={(p) => p.id}
                mobileCards={(p) => (
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate">{p.title}</div>
                      <div className="text-xs text-muted-foreground">{formatDate(p.dueDate)}</div>
                    </div>
                    <PaidActions p={p} wsId={current.id} />
                  </div>
                )}
              />
            </div>
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
