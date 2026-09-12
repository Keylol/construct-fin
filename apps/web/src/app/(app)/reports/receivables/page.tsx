'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { ChevronRight, RotateCcw, Users } from '@/components/ui/icons';
import { Money } from '@/components/ui/Money';
import { formatRub } from '@construct/shared';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { FilterBar } from '@/components/ui/FilterBar';
import { FilterField } from '@/components/ui/FilterField';
import { Input } from '@/components/ui/Input';
import { KpiCard } from '@/components/ui/KpiCard';
import { KpiRow } from '@/components/ui/KpiRow';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useReceivables } from '@/hooks/useTradeReports';
import { useUrlFilters } from '@/hooks/useUrlFilters';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/dates';
import { fromLocalDateInput, todayInput } from '@/lib/periods';
import { flatCodec } from '@/lib/url-codec';
import type { AgingBucketKey, ReceivableClientRow, ReceivableOrder } from '@/lib/types';

type LinkHref = Parameters<typeof Link>[0]['href'];

const BUCKET_TONE: Record<AgingBucketKey, string> = {
  '0-30': 'text-foreground',
  '30-60': 'text-warning',
  '60+': 'text-destructive',
};

// Пустая дата = «сегодня» (локальная, UTC+5): умолчание не пишется в адрес.
const DEFAULTS = { asOf: '' };
const CODEC = flatCodec(DEFAULTS);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const clientKey = (c: ReceivableClientRow) => c.clientId ?? 'none';

// useSearchParams требует Suspense-границу на уровне page (Next 14 App Router).
export default function ReceivablesReportPage() {
  return (
    <Suspense>
      <ReceivablesReportView />
    </Suspense>
  );
}

function ReceivablesReportView() {
  const { currentId: wsId } = useCurrentWorkspace();
  const [filters, setFilters] = useUrlFilters(CODEC);
  const asOf = filters.asOf || todayInput();
  // Невалидная дата не должна ронять запрос: undefined → бэкенд берёт «сейчас».
  const asOfIso = DATE_RE.test(asOf) ? fromLocalDateInput(asOf) : undefined;
  const query = useReceivables(wsId, asOfIso);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  if (!wsId) return null;

  const data = query.data;
  const clients = data?.clients ?? [];
  const overdue = data && data.overdueByPlanTotal !== '0.00' ? data.overdueByPlanTotal : null;

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const name = (c: ReceivableClientRow) => (
    <span className="inline-flex items-center gap-1.5">
      <ChevronRight
        className={cn(
          'h-3.5 w-3.5 text-muted-foreground transition-transform',
          expanded.has(clientKey(c)) && 'rotate-90',
        )}
      />
      {/* Drill-down в карточку клиента (отчёт не мапится на /transactions).
          Только имя-ярлык — клик по остальной строке разворачивает заказы. */}
      {c.clientId ? (
        <Link
          href={`/clients/${c.clientId}` as LinkHref}
          className="hover:text-primary hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {c.clientName}
        </Link>
      ) : (
        c.clientName
      )}
      <span className="text-xs text-muted-foreground">({c.orders.length})</span>
    </span>
  );

  const columns: Column<ReceivableClientRow>[] = [
    { key: 'client', header: 'Клиент', cell: name },
    { key: '0-30', header: '0–30', align: 'right', cell: (c) => <Money value={c.buckets['0-30']} /> },
    { key: '30-60', header: '30–60', align: 'right', cell: (c) => <Money value={c.buckets['30-60']} /> },
    {
      key: '60+',
      header: '60+',
      align: 'right',
      cell: (c) => <Money value={c.buckets['60+']} tone="plain" className="text-destructive" />,
    },
    {
      key: 'due',
      header: 'К получению',
      align: 'right',
      cell: (c) => (
        <>
          <Money value={c.due} className="font-medium" />
          {c.overdueByPlan !== '0.00' && (
            <div className="text-xs font-normal text-destructive">
              просрочено {formatRub(c.overdueByPlan)}
            </div>
          )}
        </>
      ),
    },
  ];
  const card = (c: ReceivableClientRow) => (
    <div className="flex items-baseline justify-between gap-3">
      <div className="min-w-0">
        <div className="truncate font-medium">{name(c)}</div>
        <div className="text-xs text-muted-foreground">
          0–30 <Money value={c.buckets['0-30']} tone="plain" /> · 30–60{' '}
          <Money value={c.buckets['30-60']} tone="plain" /> · 60+{' '}
          <Money value={c.buckets['60+']} tone="plain" />
        </div>
      </div>
      <Money value={c.due} className="font-semibold" />
    </div>
  );

  return (
    <>
      <FilterBar>
        <FilterField label="На дату">
          <Input
            type="date"
            value={asOf}
            onChange={(e) => setFilters({ asOf: e.target.value })}
            className="h-9 w-[160px]"
          />
        </FilterField>
        <Button variant="ghost" size="sm" onClick={() => setFilters(DEFAULTS)} className="self-end">
          <RotateCcw className="h-3.5 w-3.5" />
          Сегодня
        </Button>
      </FilterBar>

      <div className="space-y-4 px-6 py-4">
        {query.isError ? (
          <ErrorState error={query.error} onRetry={() => query.refetch()} />
        ) : (
          <KpiRow loading={query.isLoading} count={4} className="stagger">
            {data && (
              <>
                {/* F2: просрочка по формальным графикам платежей (не по возрасту). */}
                <KpiCard
                  label="Всего к получению"
                  value={<Money value={data.totalDue} />}
                  tone={overdue ? 'negative' : 'neutral'}
                  hint={overdue ? `просрочено по графику ${formatRub(overdue)}` : undefined}
                />
                <KpiCard label="0–30 дней" value={<Money value={data.buckets['0-30']} />} tone="positive" />
                <KpiCard label="30–60 дней" value={<Money value={data.buckets['30-60']} />} tone="warning" />
                <KpiCard label="60+ дней" value={<Money value={data.buckets['60+']} />} tone="negative" />
              </>
            )}
          </KpiRow>
        )}

        {data && (
          <Card className="overflow-hidden !p-0">
            <DataTable
              data={clients}
              columns={columns}
              rowKey={clientKey}
              onRowClick={(c) => toggle(clientKey(c))}
              renderExpanded={(c) =>
                expanded.has(clientKey(c)) ? <OrdersList orders={c.orders} /> : null
              }
              mobileCards={card}
              empty={
                <EmptyState
                  icon={Users}
                  title="Нет неоплаченных заказов на эту дату"
                  hint="Дебиторская задолженность — незакрытые долги клиентов по заказам."
                />
              }
              footer={
                clients.length > 0
                  ? {
                      client: 'Итого',
                      '0-30': <Money value={data.buckets['0-30']} />,
                      '30-60': <Money value={data.buckets['30-60']} />,
                      '60+': <Money value={data.buckets['60+']} />,
                      due: <Money value={data.totalDue} />,
                    }
                  : undefined
              }
            />
          </Card>
        )}
      </div>
    </>
  );
}

/** Заказы клиента под раскрытой строкой: номер, возраст, покрытие, долг. */
function OrdersList({ orders }: { orders: ReceivableOrder[] }) {
  return (
    <ul className="divide-y divide-border/60 text-xs">
      {orders.map((o) => (
        <li key={o.orderId} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-1.5">
          <span className="text-muted-foreground">
            № {o.number} · {formatDate(o.createdAt)} · {o.ageDays} дн.
          </span>
          <span className="flex items-baseline gap-3 tabular-nums text-muted-foreground">
            {o.overdueByPlan && o.overdueByPlan !== '0.00' && (
              <span className="text-destructive">
                просрочено {formatRub(o.overdueByPlan)}
                {o.nextDueDate ? ` (срок ${formatDate(o.nextDueDate)})` : ''}
              </span>
            )}
            <span>
              оплачено {formatRub(o.paid)} из {formatRub(o.total)}
            </span>
            <Money value={o.due} tone="plain" className={cn('text-sm', BUCKET_TONE[o.bucket])} />
          </span>
        </li>
      ))}
    </ul>
  );
}
