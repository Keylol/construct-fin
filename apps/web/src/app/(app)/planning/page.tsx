'use client';

import { useState, Suspense } from 'react';
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
import { useUrlFilters } from '@/hooks/useUrlFilters';
import { flatCodec } from '@/lib/url-codec';
import { FilterBar, FilterReset } from '@/components/ui/FilterBar';
import { FilterField } from '@/components/ui/FilterField';
import { Select } from '@/components/ui/Select';

// Горизонт (дней вперёд) — один на прогноз и «Ближайшие платежи», живёт в адресе.
const HORIZONS = [30, 60, 90, 180] as const;
const DEFAULTS = { days: '60' };
const FILTERS = flatCodec(DEFAULTS);

// useSearchParams требует Suspense-границу на уровне page (Next 14 App Router).
export default function PlanningPage() {
  return (
    <Suspense>
      <PlanningView />
    </Suspense>
  );
}

function PlanningView() {
  const { current } = useCurrentWorkspace();
  const wsId = current?.id ?? null;
  const [filters, setFilters] = useUrlFilters(FILTERS);
  const days = (HORIZONS as readonly number[]).includes(Number(filters.days)) ? Number(filters.days) : 60;
  const upcoming = useUpcoming(wsId, days);
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

      <div className="px-6 py-4">
        <KpiRow loading={upcoming.isLoading || recurring.isLoading}>
          <KpiCard
            label="Просрочено"
            value={<Money value={up?.overdueSum ?? '0'} />}
            tone={(up?.overdueCount ?? 0) > 0 ? 'negative' : 'neutral'}
            hint={`${up?.overdueCount ?? 0} ${plural(up?.overdueCount ?? 0, 'платёж', 'платежа', 'платежей')}`}
          />
          <KpiCard
            label="Скоро"
            value={<Money value={up?.soonSum ?? '0'} />}
            tone={(up?.soonCount ?? 0) > 0 ? 'warning' : 'neutral'}
            hint={`${up?.soonCount ?? 0} ${plural(up?.soonCount ?? 0, 'платёж', 'платежа', 'платежей')} в ближайшие дни`}
          />
          <KpiCard
            label="Регулярных"
            value={String(recurring.data?.length ?? 0)}
            hint={plural(recurring.data?.length ?? 0, 'правило', 'правила', 'правил')}
          />
        </KpiRow>
      </div>

      <FilterBar>
        {/* Здесь период смотрит ВПЕРЁД — горизонт прогноза и ближайших платежей,
            а не «период назад» из отчётов. Оболочка та же, набор значений свой. */}
        <FilterField label="Горизонт">
          <Select
            value={String(days)}
            onChange={(e) => setFilters({ days: e.target.value })}
            className="h-9 w-[170px]"
          >
            {HORIZONS.map((d) => (
              <option key={d} value={d}>
                {d} дней
              </option>
            ))}
          </Select>
        </FilterField>
        <FilterReset onClick={() => setFilters(DEFAULTS)} />
      </FilterBar>

      <div className="space-y-6 px-6 py-4">
        {/* Прогноз остатка: кассовый разрыв виден заранее. */}
        <ForecastCard wsId={current.id} days={days} />


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
