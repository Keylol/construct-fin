'use client';

import { useMemo, useState } from 'react';
import { Lock, Unlock, CalendarDays } from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { toast } from '@/components/ui/Toaster';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import {
  usePeriods,
  useClosePeriod,
  useReopenPeriod,
  type AccountingPeriod,
} from '@/hooks/usePeriods';
import { ApiError } from '@/lib/api';

const MONTH_LABEL = [
  'Январь',
  'Февраль',
  'Март',
  'Апрель',
  'Май',
  'Июнь',
  'Июль',
  'Август',
  'Сентябрь',
  'Октябрь',
  'Ноябрь',
  'Декабрь',
];

interface MonthCell {
  year: number;
  month: number;
  status: 'OPEN' | 'CLOSED' | 'FUTURE';
  closedAt: string | null;
  isCurrent: boolean;
  recordId: string | null;
}

/** Возвращает 24 последних месяца до текущего включительно (по убыванию). */
function buildMonthGrid(records: AccountingPeriod[], months = 24): MonthCell[] {
  const now = new Date();
  const curY = now.getUTCFullYear();
  const curM = now.getUTCMonth() + 1;
  const byKey = new Map(records.map((r) => [`${r.year}-${r.month}`, r] as const));
  const cells: MonthCell[] = [];
  for (let i = 0; i < months; i++) {
    let m = curM - i;
    let y = curY;
    while (m <= 0) {
      m += 12;
      y -= 1;
    }
    const rec = byKey.get(`${y}-${m}`);
    cells.push({
      year: y,
      month: m,
      status: rec?.status === 'CLOSED' ? 'CLOSED' : 'OPEN',
      closedAt: rec?.closedAt ?? null,
      isCurrent: y === curY && m === curM,
      recordId: rec?.id ?? null,
    });
  }
  return cells;
}

export default function PeriodsPage() {
  const ws = useCurrentWorkspace();
  const wsId = ws.currentId ?? '';
  const periods = usePeriods(wsId || null);
  const closeMut = useClosePeriod(wsId);
  const reopenMut = useReopenPeriod(wsId);

  const cells = useMemo(() => buildMonthGrid(periods.data ?? []), [periods.data]);

  const [pendingClose, setPendingClose] = useState<MonthCell | null>(null);
  const [pendingReopen, setPendingReopen] = useState<MonthCell | null>(null);

  async function handleClose(cell: MonthCell) {
    try {
      await closeMut.mutateAsync({ year: cell.year, month: cell.month });
      toast.success(`Период ${MONTH_LABEL[cell.month - 1]} ${cell.year} закрыт`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Не удалось закрыть период');
    }
  }

  async function handleReopen(cell: MonthCell) {
    try {
      await reopenMut.mutateAsync({ year: cell.year, month: cell.month });
      toast.success(`Период ${MONTH_LABEL[cell.month - 1]} ${cell.year} открыт`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Не удалось открыть период');
    }
  }

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Закрытие месяца"
        description="Зафиксируйте отчётный период — после закрытия правки в его датах будут отклоняться."
      />
      <div className="px-6 py-6">
        {periods.isLoading ? (
          <div className="text-sm text-muted-foreground">Загрузка…</div>
        ) : cells.length === 0 ? (
          <EmptyState
            icon={CalendarDays}
            title="Нет периодов"
            hint="Создайте первую операцию — система автоматически предложит периоды."
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
            {cells.map((cell) => {
              const closed = cell.status === 'CLOSED';
              return (
                <div
                  key={`${cell.year}-${cell.month}`}
                  className="flex flex-col gap-2 rounded-md border border-border bg-card p-4 shadow-sm"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-sm font-semibold">
                        {MONTH_LABEL[cell.month - 1]} {cell.year}
                      </div>
                      {cell.isCurrent && (
                        <div className="text-xs text-muted-foreground">текущий месяц</div>
                      )}
                      {cell.closedAt && (
                        <div className="text-xs text-muted-foreground">
                          закрыт {new Date(cell.closedAt).toLocaleDateString('ru-RU')}
                        </div>
                      )}
                    </div>
                    <Badge variant={closed ? 'secondary' : 'success'}>
                      {closed ? 'Закрыт' : 'Открыт'}
                    </Badge>
                  </div>
                  <div className="mt-1">
                    {closed ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        className="w-full"
                        onClick={() => setPendingReopen(cell)}
                      >
                        <Unlock className="mr-1.5 h-3.5 w-3.5" />
                        Открыть
                      </Button>
                    ) : (
                      <Button
                        variant="secondary"
                        size="sm"
                        className="w-full"
                        disabled={cell.isCurrent}
                        title={cell.isCurrent ? 'Нельзя закрыть текущий месяц' : undefined}
                        onClick={() => setPendingClose(cell)}
                      >
                        <Lock className="mr-1.5 h-3.5 w-3.5" />
                        Закрыть
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={pendingClose !== null}
        onOpenChange={(open) => !open && setPendingClose(null)}
        title="Закрыть период?"
        description={
          pendingClose
            ? `${MONTH_LABEL[pendingClose.month - 1]} ${pendingClose.year}: после закрытия редактировать операции этого месяца нельзя.`
            : ''
        }
        confirmText="Закрыть"
        variant="primary"
        loading={closeMut.isPending}
        onConfirm={async () => {
          if (pendingClose) await handleClose(pendingClose);
        }}
      />

      <ConfirmDialog
        open={pendingReopen !== null}
        onOpenChange={(open) => !open && setPendingReopen(null)}
        title="Снова открыть период?"
        description={
          pendingReopen
            ? `${MONTH_LABEL[pendingReopen.month - 1]} ${pendingReopen.year}: операции этого месяца снова можно редактировать.`
            : ''
        }
        confirmText="Открыть"
        variant="primary"
        loading={reopenMut.isPending}
        onConfirm={async () => {
          if (pendingReopen) await handleReopen(pendingReopen);
        }}
      />
    </div>
  );
}
