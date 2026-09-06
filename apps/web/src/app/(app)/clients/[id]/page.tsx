'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ChevronLeft, ClipboardList, ArrowRight } from '@/components/ui/icons';
import { Money } from '@/components/ui/Money';
import { formatRub } from '@construct/shared';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useCounterparties } from '@/hooks/useCounterparties';
import { useOrders } from '@/hooks/useOrders';
import { useMarginReport, useReceivables } from '@/hooks/useTradeReports';
import { PageHeader } from '@/components/ui/PageHeader';
import { Card } from '@/components/ui/Card';
import { KpiCard } from '@/components/ui/KpiCard';
import { StatusDot } from '@/components/ui/StatusDot';
import { PAY_LABEL, PAY_TONE, STATUS_LABEL, STATUS_TONE } from '@/components/orders/order-shared';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { Button } from '@/components/ui/Button';
import { formatDate } from '@/lib/dates';
import { txDrilldownHref } from '@/lib/tx-filters';

// typedRoutes: динамические href собираются строкой — каст к типу href из Link.
type LinkHref = Parameters<typeof Link>[0]['href'];

export default function ClientCardPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
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
        <div className="grid gap-4 sm:grid-cols-3">
          <KpiCard
            label="Выручка за месяц"
            value={
              marginQ.isLoading ? (
                <Skeleton className="h-7 w-24" />
              ) : (
                formatRub(marginRow?.revenue ?? '0')
              )
            }
            tone="positive"
          />
          <KpiCard
            label="Валовая прибыль за месяц"
            value={
              marginQ.isLoading ? (
                <Skeleton className="h-7 w-24" />
              ) : (
                formatRub(marginRow?.margin ?? '0')
              )
            }
            tone={Number(marginRow?.margin ?? 0) >= 0 ? 'positive' : 'negative'}
          />
          <KpiCard
            label="Дебиторская задолженность"
            value={
              receivablesQ.isLoading ? (
                <Skeleton className="h-7 w-24" />
              ) : (
                formatRub(receivableRow?.due ?? '0')
              )
            }
            tone={Number(receivableRow?.due ?? 0) > 0 ? 'negative' : 'neutral'}
            hint={overdue ? `просрочено ${formatRub(overdue)}` : undefined}
          />
        </div>
        {(marginQ.isError || receivablesQ.isError) && (
          <p className="text-xs text-destructive">Часть показателей не загрузилась.</p>
        )}

        {/* Заказы клиента */}
        <Card className="!p-0">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="text-sm font-semibold">Заказы</div>
            <Button asChild variant="ghost" size="sm">
              <Link href="/orders">
                Все заказы <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </Button>
          </div>
          {ordersQ.isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : ordersQ.isError ? (
            <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
              <p className="text-sm text-muted-foreground">Не удалось загрузить заказы.</p>
              <Button variant="secondary" size="sm" onClick={() => ordersQ.refetch()}>
                Повторить
              </Button>
            </div>
          ) : orders.length === 0 ? (
            <div className="px-4 py-8">
              <EmptyState
                icon={ClipboardList}
                title="Заказов нет"
                hint="У этого клиента пока нет заказов."
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-base">
                <thead className="border-b border-border">
                  <tr className="text-left text-xs uppercase text-muted-foreground">
                    <th className="px-4 py-2 font-medium">Номер</th>
                    <th className="px-4 py-2 font-medium">Статус</th>
                    <th className="px-4 py-2 font-medium">Оплата</th>
                    <th className="px-4 py-2 text-right font-medium">Оплачено</th>
                    <th className="px-4 py-2 text-right font-medium">Сумма</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o) => (
                    <tr key={o.id} className="border-b border-border last:border-0">
                      <td className="px-4 py-2">
                        <div className="font-medium">{o.number}</div>
                        {o.title && (
                          <div className="max-w-[220px] truncate text-xs text-muted-foreground">
                            {o.title}
                          </div>
                        )}
                        <div className="text-xs tabular-nums text-muted-foreground">
                          {formatDate(o.createdAt)}
                        </div>
                      </td>
                      <td className="px-4 py-2">
                        <StatusDot tone={STATUS_TONE[o.status]} label={STATUS_LABEL[o.status]} />
                      </td>
                      <td className="px-4 py-2">
                        <StatusDot tone={PAY_TONE[o.paymentStatus]} label={PAY_LABEL[o.paymentStatus]} />
                      </td>
                      <td className="px-4 py-2 text-right text-muted-foreground"><Money value={o.paidAmount} tone="plain" /></td>
                      <td className="px-4 py-2 text-right font-medium"><Money value={o.totalAmount} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
