'use client';

import { useState } from 'react';
import { formatRub } from '@construct/shared';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
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

  if (!wsId) return <EmptyState title="Workspace не выбран" />;

  async function handleSubmit(input: CreateRecurringInput | UpdateRecurringInput) {
    if (editing) {
      await updateMut.mutateAsync({ id: editing.id, ...input });
    } else {
      await createMut.mutateAsync(input as CreateRecurringInput);
    }
  }

  function openCreate() {
    setEditing(null);
    setDialogOpen(true);
  }

  function openEdit(r: RecurringRule) {
    setEditing(r);
    setDialogOpen(true);
  }

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Повторяющиеся транзакции</h1>
        <Button onClick={openCreate}>Новое правило</Button>
      </header>

      {rules.isLoading && <p className="text-muted text-sm">Загрузка…</p>}

      {rules.data && rules.data.length === 0 && (
        <EmptyState
          title="Пока нет повторяющихся правил"
          hint="Создайте правило для зарплаты, аренды или подписок — Construct будет создавать транзакции автоматически"
          action={<Button onClick={openCreate}>Создать правило</Button>}
        />
      )}

      {rules.data && rules.data.length > 0 && (
        <Card className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted border-b border-white/10">
                <th className="py-2 px-3">Название</th>
                <th className="py-2 px-3 text-right">Сумма</th>
                <th className="py-2 px-3">Расписание</th>
                <th className="py-2 px-3">След. запуск</th>
                <th className="py-2 px-3">Посл. запуск</th>
                <th className="py-2 px-3">Статус</th>
                <th className="py-2 px-3"></th>
              </tr>
            </thead>
            <tbody>
              {rules.data.map((r) => (
                <tr key={r.id} className="border-b border-white/5">
                  <td className="py-2 px-3 font-medium">{r.name}</td>
                  <td
                    className={`py-2 px-3 text-right whitespace-nowrap ${
                      r.templateJson.type === 'INCOME' ? 'text-success' : 'text-danger'
                    }`}
                  >
                    {r.templateJson.type === 'INCOME' ? '+' : '−'}{' '}
                    {formatRub(r.templateJson.amount)}
                  </td>
                  <td className="py-2 px-3 text-muted">{describeRule(r)}</td>
                  <td className="py-2 px-3 whitespace-nowrap text-muted">
                    {new Date(r.nextRunAt).toLocaleDateString('ru-RU')}
                  </td>
                  <td className="py-2 px-3 whitespace-nowrap text-muted">
                    {r.lastRunAt
                      ? new Date(r.lastRunAt).toLocaleDateString('ru-RU')
                      : '—'}
                  </td>
                  <td className="py-2 px-3">
                    {r.active ? (
                      <span className="text-xs text-success">активно</span>
                    ) : (
                      <span className="text-xs text-muted">пауза</span>
                    )}
                  </td>
                  <td className="py-2 px-3 text-right whitespace-nowrap">
                    <div className="inline-flex gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => runNowMut.mutate(r.id)}
                        disabled={runNowMut.isPending || !r.active}
                        title="Выполнить сейчас (создаст пропущенные за период до 30 дней)"
                      >
                        ▶
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => openEdit(r)}>
                        ✎
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => {
                          if (confirm(`Удалить правило «${r.name}»?`)) {
                            deleteMut.mutate(r.id);
                          }
                        }}
                      >
                        ×
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {runNowMut.data && (
        <p className="text-sm text-success">
          Создано: {runNowMut.data.created}, пропущено дублей: {runNowMut.data.skipped}
        </p>
      )}

      <RecurringFormDialog
        wsId={wsId}
        open={dialogOpen}
        rule={editing}
        onClose={() => setDialogOpen(false)}
        onSubmit={handleSubmit}
      />
    </div>
  );
}
