'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ChevronLeft, Package, Truck, ArrowRight } from '@/components/ui/icons';
import { formatRub, add, D, toMoneyString } from '@construct/shared';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useCounterparties } from '@/hooks/useCounterparties';
import { usePurchases } from '@/hooks/usePurchases';
import { PageHeader } from '@/components/ui/PageHeader';
import { Card } from '@/components/ui/Card';
import { KpiCard } from '@/components/ui/KpiCard';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { Button } from '@/components/ui/Button';
import type { Purchase } from '@/lib/types';
import { formatDate } from '@/lib/dates';
import { txDrilldownHref } from '@/lib/tx-filters';

// typedRoutes: динамические href собираются строкой — каст к типу href из Link.
type LinkHref = Parameters<typeof Link>[0]['href'];

// Сумма закупки: фактическая проводка (transaction.amount), иначе Σ строк.
function purchaseTotal(p: Purchase): string {
  if (p.transaction?.amount) return p.transaction.amount;
  return toMoneyString(p.lines.reduce((acc, l) => add(acc, l.lineTotal), D(0)));
}

export default function SupplierCardPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const { current } = useCurrentWorkspace();
  const wsId = current?.id ?? null;

  const suppliersQ = useCounterparties(wsId, '', false, 'SUPPLIER');
  const supplier = suppliersQ.data?.find((c) => c.id === id) ?? null;

  const purchasesQ = usePurchases(wsId, id);
  const purchases = purchasesQ.data ?? [];
  // Общая сумма закупок — Decimal-сложение (деньги никогда через float).
  const total = purchases.reduce((acc, p) => add(acc, purchaseTotal(p)), D(0));

  if (!current) {
    return (
      <>
        <PageHeader title="Поставщик" />
        <div className="p-6">
          <EmptyState
            icon={Truck}
            title="Нет активного пространства"
            hint="Выберите или создайте пространство."
          />
        </div>
      </>
    );
  }

  return (
    <>
      <div className="bg-background px-6 pt-4">
        <Link
          href="/suppliers"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" /> Поставщики
        </Link>
      </div>

      <PageHeader
        title={
          supplier?.name ??
          (suppliersQ.isLoading
            ? 'Загрузка…'
            : suppliersQ.isError
              ? 'Ошибка загрузки'
              : 'Поставщик не найден')
        }
        actions={
          <Button asChild variant="secondary">
            <Link href={txDrilldownHref({ counterpartyId: id }) as LinkHref}>
              Все операции <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        }
      />

      <div className="space-y-4 px-6 py-4">
        {/* ИНН / контакт / примечание */}
        {supplier && (supplier.inn || supplier.contact || supplier.note) && (
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
            {supplier.inn && (
              <span>
                ИНН: <span className="tabular-nums text-foreground">{supplier.inn}</span>
              </span>
            )}
            {supplier.contact && (
              <span>
                Контакт: <span className="text-foreground">{supplier.contact}</span>
              </span>
            )}
            {supplier.note && (
              <span>
                Примечание: <span className="text-foreground">{supplier.note}</span>
              </span>
            )}
          </div>
        )}

        {/* KPI: сумма и количество закупок (долга/маржи по поставщику нет) */}
        <div className="grid gap-4 sm:grid-cols-2">
          <KpiCard
            label="Сумма закупок"
            value={
              purchasesQ.isLoading ? (
                <Skeleton className="h-7 w-24" />
              ) : (
                formatRub(toMoneyString(total))
              )
            }
          />
          <KpiCard
            label="Закупок"
            value={
              purchasesQ.isLoading ? (
                <Skeleton className="h-7 w-16" />
              ) : (
                String(purchases.length)
              )
            }
          />
        </div>

        {/* Закупки поставщика */}
        <Card className="!p-0">
          <div className="border-b border-border px-4 py-3 text-sm font-semibold">Закупки</div>
          {purchasesQ.isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : purchasesQ.isError ? (
            <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
              <p className="text-sm text-muted-foreground">Не удалось загрузить закупки.</p>
              <Button variant="secondary" size="sm" onClick={() => purchasesQ.refetch()}>
                Повторить
              </Button>
            </div>
          ) : purchases.length === 0 ? (
            <div className="px-4 py-8">
              <EmptyState
                icon={Package}
                title="Закупок нет"
                hint="У этого поставщика пока нет закупок."
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-border">
                  <tr className="text-left text-xs uppercase text-muted-foreground">
                    <th className="px-4 py-2 font-medium">Дата</th>
                    <th className="px-4 py-2 text-right font-medium">Позиций</th>
                    <th className="px-4 py-2 font-medium">Комментарий</th>
                    <th className="px-4 py-2 text-right font-medium">Сумма</th>
                  </tr>
                </thead>
                <tbody>
                  {purchases.map((p) => (
                    <tr key={p.id} className="border-b border-border last:border-0">
                      <td className="whitespace-nowrap px-4 py-2 tabular-nums text-muted-foreground">
                        {formatDate(p.transaction?.date ?? p.createdAt)}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">{p.lines.length}</td>
                      <td className="px-4 py-2 text-muted-foreground">
                        <span className="block max-w-[280px] truncate" title={p.note ?? ''}>
                          {p.note ?? '—'}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right font-medium tabular-nums">
                        {formatRub(purchaseTotal(p))}
                      </td>
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
