'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ChevronLeft, ClipboardList, ArrowRight } from '@/components/ui/icons';
import { Money } from '@/components/ui/Money';
import { D, formatRub } from '@construct/shared';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useCounterparties } from '@/hooks/useCounterparties';
import { useOrders } from '@/hooks/useOrders';
import { useMarginReport, useReceivables } from '@/hooks/useTradeReports';
import { PageHeader } from '@/components/ui/PageHeader';
import { SectionCard } from '@/components/ui/SectionCard';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { KpiCard } from '@/components/ui/KpiCard';
import { KpiRow } from '@/components/ui/KpiRow';
import { StatusDot } from '@/components/ui/StatusDot';
import { PAY_LABEL, PAY_TONE, STATUS_LABEL, STATUS_TONE } from '@/components/orders/order-shared';
import { EmptyState } from '@/components/ui/EmptyState';
import { Button } from '@/components/ui/Button';
import { formatDate } from '@/lib/dates';
import { txDrilldownHref } from '@/lib/tx-filters';
import type { Order } from '@/lib/types';

// typedRoutes: динамические href собираются строкой — каст к типу href из Link.
type LinkHref = Parameters<typeof Link>[0]['href'];

const ORDER_COLUMNS: Column<Order>[] = [
  {
    key: 'number',
    header: 'Номер',
    cell: (o) => (
      <div>
        <div className="font-medium">{o.number}</div>
        {o.title && (
          <div className="max-w-[220px] truncate text-xs text-muted-foreground">{o.title}</div>
        )}
        <div className="text-xs tabular-nums text-muted-foreground">{formatDate(o.createdAt)}</div>
      </div>
    ),
  },
  {
    key: 'status',
    header: 'Статус',
    cell: (o) => <StatusDot tone={STATUS_TONE[o.status]} label={STATUS_LABEL[o.status]} />,
  },
  {
    key: 'pay',
    header: 'Оплата',
    cell: (o) => <StatusDot tone={PAY_TONE[o.paymentStatus]} label={PAY_LABEL[o.paymentStatus]} />,
  },
  {
    key: 'paid',
    header: 'Оплачено',
    align: 'right',
    cell: (o) => <Money value={o.paidAmount} tone="plain" className="text-muted-foreground" />,
  },
  {
    key: 'total',
    header: 'Сумма',
    align: 'right',
    cell: (o) => <Money value={o.totalAmount} className="font-medium" />,
  },
];

const orderCard = (o: Order) => (
  <div className="flex items-baseline justify-between gap-3">
    <div className="min-w-0">
      <div className="truncate font-medium">
        {o.number}
        {o.title && <span className="text-muted-foreground"> · {o.title}</span>}
      </div>
      <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
        <span>{formatDate(o.createdAt)}</span>
        <StatusDot tone={STATUS_TONE[o.status]} label={STATUS_LABEL[o.status]} className="text-xs" />
        <StatusDot tone={PAY_TONE[o.paymentStatus]} label={PAY_LABEL[o.paymentStatus]} className="text-xs" />
      </div>
    </div>
    <Money value={o.totalAmount} className="font-semibold" />
  </div>
);

export default function ClientCardPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();
  const { current } = useCurrentWorkspace();
  const wsId = current?.id ?? null;

  // Клиент — из общего списка контрагентов (клиентская агрегация, без нового API).
  const clientsQ = useCounterparties(wsId, '', false, 'CLIENT');
  const client = clientsQ.data?.find((c) => c.id === id) ?? null;

  // Выручка/прибыль за месяц — строка by-client маржи с key === id клиента.
  const marginQ = useMarginReport('by-client', wsId, { preset: 'this-month' });
  const marginRow = marginQ.data?.rows.find((r) => r.key === id) ?? null;

  // Задолженность/просрочка — строка дебиторки этого клиента.
  const receivablesQ = useReceivables(wsId);
  const receivableRow = receivablesQ.data?.clients.find((c) => c.clientId === id) ?? null;

  // Заказы клиента — первой страницы достаточно (без «Загрузить ещё»).
  const ordersQ = useOrders(wsId, { clientId: id });
  const orders = ordersQ.data?.pages.flatMap((p) => p.items) ?? [];

  if (!current) return null;

  const overdue =
    receivableRow && receivableRow.overdueByPlan !== '0.00'
      ? receivableRow.overdueByPlan
      : null;

  return (
    <>
      <div className="bg-background px-6 pt-4">
        <Link
          href="/clients"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" /> Клиенты
        </Link>
      </div>

      <PageHeader
        title={
          client?.name ??
          (clientsQ.isLoading
            ? 'Загрузка…'
            : clientsQ.isError
              ? 'Ошибка загрузки'
              : 'Клиент не найден')
        }
        actions={
          <Button asChild variant="secondary">
            <Link href={txDrilldownHref({ counterpartyId: id }) as LinkHref}>
              Все операции клиента <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        }
      />

      <div className="space-y-4 px-6 py-4">
        {/* Контакт / источник / примечание */}
        {client && (client.contact || client.source || client.note) && (
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
            {client.contact && (
              <span>
                Контакт: <span className="text-foreground">{client.contact}</span>
              </span>
            )}
            {client.source && (
              <span>
                Источник: <span className="text-foreground">{client.source}</span>
              </span>
            )}
            {client.note && (
              <span>
                Примечание: <span className="text-foreground">{client.note}</span>
              </span>
            )}
          </div>
        )}

        {/* KPI: выручка/прибыль за месяц + долг */}
        <KpiRow loading={marginQ.isLoading || receivablesQ.isLoading} count={3}>
          <KpiCard
            label="Выручка за месяц"
            value={<Money value={marginRow?.revenue ?? '0'} />}
            tone="positive"
          />
          <KpiCard
            label="Валовая прибыль за месяц"
            value={<Money value={marginRow?.margin ?? '0'} />}
            tone={D(marginRow?.margin ?? 0).gte(0) ? 'positive' : 'negative'}
          />
          <KpiCard
            label="Дебиторская задолженность"
            value={<Money value={receivableRow?.due ?? '0'} />}
            tone={D(receivableRow?.due ?? 0).gt(0) ? 'negative' : 'neutral'}
            hint={overdue ? `просрочено ${formatRub(overdue)}` : undefined}
          />
        </KpiRow>
        {(marginQ.isError || receivablesQ.isError) && (
          <p className="text-xs text-destructive">Часть показателей не загрузилась.</p>
        )}

        {/* Заказы клиента: строка открывает окно заказа на экране заказов. */}
        <SectionCard
          title="Заказы"
          aside={
            <Button asChild variant="ghost" size="sm">
              <Link href="/orders">
                Все заказы <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </Button>
          }
        >
          <DataTable
            data={orders}
            columns={ORDER_COLUMNS}
            rowKey={(o) => o.id}
            onRowClick={(o) =>
              router.push(`/orders?order=${o.id}` as Parameters<typeof router.push>[0])
            }
            loading={ordersQ.isLoading}
            error={ordersQ.error}
            onRetry={() => ordersQ.refetch()}
            empty={
              <EmptyState
                icon={ClipboardList}
                title="Заказов нет"
                hint="У этого клиента пока нет заказов."
              />
            }
            mobileCards={orderCard}
          />
        </SectionCard>
      </div>
    </>
  );
}
