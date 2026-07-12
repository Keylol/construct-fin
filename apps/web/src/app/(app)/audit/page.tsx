'use client';

import { useMemo } from 'react';
import { History } from '@/components/ui/icons';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useAudit } from '@/hooks/useAudit';
import type { AuditEntry } from '@/lib/types';
import { formatDateTime } from '@/lib/dates';
import { PageHeader } from '@/components/ui/PageHeader';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { Badge, type BadgeProps } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';

// Человекочитаемые подписи и визуальный вес действий аудита.
// Ключи синхронны с AuditAction в apps/api/src/audit/audit.service.ts.
const ACTION_META: Record<string, { label: string; variant: BadgeProps['variant'] }> = {
  'order.finalize': { label: 'Заказ завершён', variant: 'success' },
  'order.cancel': { label: 'Заказ отменён', variant: 'destructive' },
  'order.reopen': { label: 'Заказ переоткрыт', variant: 'secondary' },
  'order.restore': { label: 'Заказ восстановлен', variant: 'secondary' },
  'order.delete': { label: 'Заказ удалён', variant: 'destructive' },
  'order.refund': { label: 'Возврат по заказу', variant: 'destructive' },
  'period.close': { label: 'Период закрыт', variant: 'success' },
  'period.reopen': { label: 'Период переоткрыт', variant: 'secondary' },
  'purchase.register': { label: 'Закупка', variant: 'success' },
  'warehouse.supplier-return': { label: 'Возврат поставщику', variant: 'destructive' },
  'transaction.update': { label: 'Операция изменена', variant: 'secondary' },
  'transaction.delete': { label: 'Операция удалена', variant: 'destructive' },
};

function actionMeta(action: string) {
  return ACTION_META[action] ?? { label: action, variant: 'muted' as const };
}

function hasDiff(diff: unknown): diff is Record<string, unknown> {
  return !!diff && typeof diff === 'object' && Object.keys(diff as object).length > 0;
}

export default function AuditPage() {
  const { currentId } = useCurrentWorkspace();
  const query = useAudit(currentId);

  const rows = useMemo<AuditEntry[]>(
    () => query.data?.pages.flatMap((p) => p.items) ?? [],
    [query.data],
  );

  const columns: Column<AuditEntry>[] = [
    {
      key: 'createdAt',
      header: 'Время',
      className: 'whitespace-nowrap text-muted-foreground',
      cell: (r) => formatDateTime(r.createdAt),
    },
    {
      key: 'action',
      header: 'Действие',
      cell: (r) => {
        const m = actionMeta(r.action);
        return <Badge variant={m.variant}>{m.label}</Badge>;
      },
    },
    {
      key: 'entity',
      header: 'Объект',
      className: 'text-muted-foreground',
      cell: (r) => (
        <span className="font-mono text-xs">
          {r.entityType}
          <span className="opacity-60"> · {r.entityId.slice(0, 8)}</span>
        </span>
      ),
    },
    {
      key: 'actor',
      header: 'Кто',
      cell: (r) => r.actor?.name ?? '—',
    },
    {
      key: 'diff',
      header: 'Детали',
      cell: (r) =>
        hasDiff(r.diff) ? (
          <details className="text-xs">
            <summary className="cursor-pointer select-none text-muted-foreground">показать</summary>
            <pre className="mt-1 max-w-md overflow-auto rounded bg-muted p-2 text-[11px] leading-snug">
              {JSON.stringify(r.diff, null, 2)}
            </pre>
          </details>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Журнал аудита"
        description="История критичных операций: заказы, закупки, закрытие периода, правки и удаления операций."
      />
      <div className="px-6 py-5">
        <DataTable
          data={rows}
          columns={columns}
          rowKey={(r) => r.id}
          loading={query.isLoading}
          error={query.error}
          onRetry={() => query.refetch()}
          empty={
            <EmptyState
              icon={History}
              title="Пока пусто"
              hint="Критичные действия будут появляться здесь по мере работы."
            />
          }
        />
        {query.hasNextPage && (
          <div className="mt-4 flex justify-center">
            <Button
              variant="secondary"
              onClick={() => query.fetchNextPage()}
              disabled={query.isFetchingNextPage}
            >
              {query.isFetchingNextPage ? 'Загрузка…' : 'Загрузить ещё'}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
