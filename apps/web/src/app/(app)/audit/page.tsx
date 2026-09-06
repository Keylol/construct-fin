'use client';

import { useMemo } from 'react';
import { History } from '@/components/ui/icons';
import { LoadMore } from '@/components/ui/LoadMore';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useAudit } from '@/hooks/useAudit';
import type { AuditEntry } from '@/lib/types';
import { formatDateTime } from '@/lib/dates';
import { PageHeader } from '@/components/ui/PageHeader';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { StatusDot } from '@/components/ui/StatusDot';

// Человекочитаемые подписи и визуальный вес действий аудита.
// Ключи синхронны с AuditAction в apps/api/src/audit/audit.service.ts.
type Tone = 'success' | 'destructive' | 'primary' | 'muted';
const ACTION_META: Record<string, { label: string; tone: Tone }> = {
  'order.finalize': { label: 'Заказ закрыт', tone: 'success' },
  'order.cancel': { label: 'Заказ отменён', tone: 'destructive' },
  'order.reopen': { label: 'Заказ переоткрыт', tone: 'primary' },
  'order.restore': { label: 'Заказ восстановлен', tone: 'primary' },
  'order.delete': { label: 'Заказ удалён', tone: 'destructive' },
  'order.refund': { label: 'Возврат по заказу', tone: 'destructive' },
  'period.close': { label: 'Период закрыт', tone: 'success' },
  'period.reopen': { label: 'Период переоткрыт', tone: 'primary' },
  'purchase.register': { label: 'Закупка', tone: 'success' },
  'warehouse.supplier-return': { label: 'Возврат поставщику', tone: 'destructive' },
  'transaction.update': { label: 'Операция изменена', tone: 'primary' },
  'transaction.delete': { label: 'Операция удалена', tone: 'destructive' },
};

function actionMeta(action: string) {
  return ACTION_META[action] ?? { label: action, tone: 'muted' as const };
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
        return <StatusDot tone={m.tone} label={m.label} />;
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
        description="История критичных действий: заказы, закупки, закрытие периода, правки и удаления операций."
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
        <LoadMore hasMore={query.hasNextPage} loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()} />
      </div>
    </div>
  );
}
