'use client';

import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';

export default function DashboardPage() {
  const { current } = useCurrentWorkspace();

  if (!current) {
    return (
      <EmptyState
        title="Нет активного пространства"
        hint="Создайте первое пространство через переключатель слева."
      />
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Главная</h1>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card>
          <div className="text-xs uppercase tracking-wide text-muted mb-1">Доход за месяц</div>
          <div className="text-2xl font-semibold">— ₽</div>
        </Card>
        <Card>
          <div className="text-xs uppercase tracking-wide text-muted mb-1">Расход за месяц</div>
          <div className="text-2xl font-semibold">— ₽</div>
        </Card>
        <Card>
          <div className="text-xs uppercase tracking-wide text-muted mb-1">Чистый результат</div>
          <div className="text-2xl font-semibold">— ₽</div>
        </Card>
      </div>
      <Card>
        <div className="text-fg font-medium mb-2">Транзакции появятся здесь</div>
        <p className="text-muted text-sm">
          Когда вы добавите счета, категории и операции, тут будут KPI, графики и список последних транзакций.
        </p>
      </Card>
    </div>
  );
}
