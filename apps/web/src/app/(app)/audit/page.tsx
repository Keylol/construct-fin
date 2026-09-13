'use client';

import { useMemo, Suspense, useRef } from 'react';
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
import { useUrlFilters } from '@/hooks/useUrlFilters';
import { flatCodec } from '@/lib/url-codec';
import { FilterBar, FilterReset } from '@/components/ui/FilterBar';
import { FilterField } from '@/components/ui/FilterField';
import { SearchField } from '@/components/ui/SearchField';
import { Select } from '@/components/ui/Select';
import { useListHotkeys } from '@/hooks/useListHotkeys';

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

const DEFAULTS = { q: '', action: '' };
const FILTERS = flatCodec(DEFAULTS);

// useSearchParams требует Suspense-границу на уровне page (Next 14 App Router).
export default function AuditPage() {
  return (
    <Suspense>
      <AuditView />
    </Suspense>
  );
}

function AuditView() {
  const { currentId } = useCurrentWorkspace();
  const query = useAudit(currentId);

  const [filters, setFilters] = useUrlFilters(FILTERS);
  const searchRef = useRef<HTMLInputElement>(null);
  useListHotkeys({ searchRef });
  // Фильтр по загруженным страницам: журнал читают редко, серверного поиска нет.
  const rows = useMemo<AuditEntry[]>(() => {
    const all = query.data?.pages.flatMap((p) => p.items) ?? [];
    const q = filters.q.trim().toLowerCase();
    return all.filter(
      (r) =>
        (!filters.action || r.action === filters.action) &&
        (!q ||
          [actionMeta(r.action).label, r.entityType, r.entityId, r.actor?.name ?? '', JSON.stringify(r.diff ?? '')]
            .join(' ')
            .toLowerCase()
            .includes(q)),
    );
  }, [query.data, filters.q, filters.action]);

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
    <>
      <PageHeader
        title="Журнал аудита"
        description="История критичных действий: заказы, закупки, закрытие периода, правки и удаления операций."
      />
      <FilterBar>
        <div className="min-w-[240px] max-w-md flex-1">
          <FilterField label="Поиск">
            <SearchField
              ref={searchRef}
              value={filters.q}
              onChange={(e) => setFilters({ ...filters, q: e.target.value })}
              placeholder="Объект, id, кто, детали"
            />
          </FilterField>
        </div>
        <FilterField label="Действие">
          <Select
            value={filters.action}
            onChange={(e) => setFilters({ ...filters, action: e.target.value })}
            className="h-9 w-[220px]"
          >
            <option value="">Все действия</option>
            {Object.entries(ACTION_META).map(([k, m]) => (
              <option key={k} value={k}>
                {m.label}
              </option>
            ))}
          </Select>
        </FilterField>
        <FilterReset onClick={() => setFilters(DEFAULTS)} />
      </FilterBar>
      <div className="bg-card">
        <DataTable
          data={rows}
          columns={columns}
          rowKey={(r) => r.id}
          loading={query.isLoading}
          error={query.error}
          onRetry={() => query.refetch()}
          empty={
            filters.q || filters.action ? (
              <EmptyState icon={History} title="Ничего не найдено" hint="Поменяйте запрос или действие." />
            ) : (
              <EmptyState
                icon={History}
                title="Пока пусто"
                hint="Критичные действия будут появляться здесь по мере работы."
              />
            )
          }
        />
        <LoadMore hasMore={query.hasNextPage} loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()} />
      </div>
    </>
  );
}
