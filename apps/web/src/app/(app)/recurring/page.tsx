'use client';

import { useState } from 'react';
import { Plus, Repeat, Play, Pencil, Trash2 } from 'lucide-react';
import { formatRub } from '@construct/shared';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { RecurringFormDialog } from '@/components/recurring/RecurringFormDialog';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import {
  useCreateRecurringRule,
  useDeleteRecurringRule,
  useRecurringRules,
  useRunRecurringNow,
  useUpdateRecurringRule,
  type CreateRecurringInput,
  type UpdateRecurringInput,
} from '@/hooks/useRecurring';
import type { RecurringFrequency, RecurringRule } from '@/lib/types';
import { cn } from '@/lib/cn';
import { toast } from '@/components/ui/Toaster';

const FREQ_LABEL: Record<RecurringFrequency, string> = {
  DAILY: 'день',
  WEEKLY: 'неделя',
  MONTHLY: 'месяц',
  YEARLY: 'год',
};

function describeRule(r: RecurringRule): string {
  const unit = FREQ_LABEL[r.frequency];
  const every = r.interval === 1 ? `Каждый ${unit}` : `Каждые ${r.interval} ${unit}`;
  if (r.frequency === 'MONTHLY' && r.dayOfMonth) return `${every}, ${r.dayOfMonth}-го`;
  if (r.frequency === 'WEEKLY' && r.dayOfWeek !== null) {
    const wd = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'][r.dayOfWeek] ?? '';
    return `${every}, ${wd}`;
  }
  return every;
}

const DATE_FMT = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

export default function RecurringPage() {
  const ws = useCurrentWorkspace();
  const wsId = ws.currentId;
  const rules = useRecurringRules(wsId);
  const createMut = useCreateRecurringRule(wsId ?? '');
  const updateMut = useUpdateRecurringRule(wsId ?? '');
  const deleteMut = useDeleteRecurringRule(wsId ?? '');
  const runNowMut = useRunRecurringNow(wsId ?? '');

  const [editing, setEditing] = useState<RecurringRule | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [delTarget, setDelTarget] = useState<RecurringRule | null>(null);

  if (!wsId) {
    return (
      <>
        <PageHeader title="Регулярные операции" />
        <div className="p-6">
          <EmptyState
            icon={Repeat}
            title="Нет активного пространства"
            hint="Выберите или создайте пространство."
          />
        </div>
      </>
    );
  }

  async function handleSubmit(input: CreateRecurringInput | UpdateRecurringInput) {
    if (editing) {
      await updateMut.mutateAsync({ id: editing.id, ...input });
    } else {
      await createMut.mutateAsync(input as CreateRecurringInput);
    }
  }

  const runNow = async (id: string) => {
    const result = await runNowMut.mutateAsync(id);
    toast.success('Запуск завершён', {
      description: `Создано: ${result.created}, пропущено дублей: ${result.skipped}`,
    });
  };

  const columns: Column<RecurringRule>[] = [
    {
      key: 'name',
      header: 'Название',
      sortable: true,
      cell: (r) => <span className="font-medium">{r.name}</span>,
    },
    {
      key: 'amount',
      header: 'Сумма',
      align: 'right',
      cell: (r) => (
        <span
          className={cn(
            'font-semibold tabular-nums',
            r.templateJson.type === 'INCOME' ? 'text-success' : 'text-destructive',
          )}
        >
          {r.templateJson.type === 'INCOME' ? '+' : '−'}
          {formatRub(r.templateJson.amount)}
        </span>
      ),
      className: 'w-[140px]',
    },
    {
      key: 'schedule',
      header: 'Расписание',
      cell: (r) => <span className="text-muted-foreground">{describeRule(r)}</span>,
    },
    {
      key: 'next',
      header: 'След. запуск',
      cell: (r) => (
        <span className="whitespace-nowrap text-muted-foreground tabular-nums">
          {DATE_FMT.format(new Date(r.nextRunAt))}
        </span>
      ),
      className: 'w-[140px]',
    },
    {
      key: 'last',
      header: 'Посл. запуск',
      cell: (r) => (
        <span className="whitespace-nowrap text-muted-foreground tabular-nums">
          {r.lastRunAt ? DATE_FMT.format(new Date(r.lastRunAt)) : '—'}
        </span>
      ),
      className: 'w-[140px]',
    },
    {
      key: 'status',
      header: 'Статус',
      cell: (r) =>
        r.active ? <Badge variant="outline">Активно</Badge> : <Badge variant="muted">Пауза</Badge>,
      className: 'w-[100px]',
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (r) => (
        <div className="inline-flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => runNow(r.id)}
            disabled={runNowMut.isPending || !r.active}
            title="Выполнить сейчас"
            aria-label="Выполнить"
          >
            <Play className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              setEditing(r);
              setDialogOpen(true);
            }}
            aria-label="Редактировать"
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setDelTarget(r)}
            aria-label="Удалить"
            className="text-destructive hover:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ),
      className: 'w-[140px]',
    },
  ];

  return (
    <>
      <PageHeader
        title="Регулярные операции"
        breadcrumbs={[{ label: 'Учёт' }, { label: 'Регулярные' }]}
        description="Зарплата, аренда, подписки — будут создаваться автоматически."
        actions={
          <Button
            onClick={() => {
              setEditing(null);
              setDialogOpen(true);
            }}
          >
            <Plus className="h-4 w-4" />
            Новое правило
          </Button>
        }
      />

      <div className="bg-card border-t border-border">
        <DataTable
          data={rules.data ?? []}
          columns={columns}
          rowKey={(r) => r.id}
          loading={rules.isLoading}
          empty={
            <EmptyState
              icon={Repeat}
              title="Пока нет правил"
              hint="Создайте правило для зарплаты, аренды или подписок — Construct будет создавать операции автоматически."
              action={
                <Button
                  onClick={() => {
                    setEditing(null);
                    setDialogOpen(true);
                  }}
                >
                  <Plus className="h-4 w-4" /> Создать правило
                </Button>
              }
            />
          }
          mobileCards={(r) => (
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">{r.name}</span>
                <span
                  className={cn(
                    'shrink-0 text-sm font-semibold tabular-nums',
                    r.templateJson.type === 'INCOME' ? 'text-success' : 'text-destructive',
                  )}
                >
                  {r.templateJson.type === 'INCOME' ? '+' : '−'}
                  {formatRub(r.templateJson.amount)}
                </span>
              </div>
              <div className="text-xs text-muted-foreground">{describeRule(r)}</div>
              <div className="text-xs text-muted-foreground">
                След. {DATE_FMT.format(new Date(r.nextRunAt))}
                {!r.active && ' · пауза'}
              </div>
              <div className="mt-2 flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => runNow(r.id)}>
                  <Play className="h-3 w-3" /> Запустить
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setEditing(r);
                    setDialogOpen(true);
                  }}
                >
                  <Pencil className="h-3 w-3" /> Изменить
                </Button>
              </div>
            </div>
          )}
        />
      </div>

      <RecurringFormDialog
        wsId={wsId}
        open={dialogOpen}
        rule={editing}
        onClose={() => setDialogOpen(false)}
        onSubmit={handleSubmit}
      />

      <ConfirmDialog
        open={!!delTarget}
        onOpenChange={(o) => !o && setDelTarget(null)}
        title={`Удалить правило «${delTarget?.name ?? ''}»?`}
        description="Уже созданные операции останутся."
        confirmText="Удалить"
        onConfirm={async () => {
          if (delTarget) await deleteMut.mutateAsync(delTarget.id);
          setDelTarget(null);
        }}
        loading={deleteMut.isPending}
      />
    </>
  );
}
