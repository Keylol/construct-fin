'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ChevronLeft, Package, ArrowRight } from '@/components/ui/icons';
import { Money } from '@/components/ui/Money';
import { add, D, toMoneyString } from '@construct/shared';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useCounterparties } from '@/hooks/useCounterparties';
import { usePurchases } from '@/hooks/usePurchases';
import { PageHeader } from '@/components/ui/PageHeader';
import { SectionCard } from '@/components/ui/SectionCard';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { KpiCard } from '@/components/ui/KpiCard';
import { KpiRow } from '@/components/ui/KpiRow';
import { EmptyState } from '@/components/ui/EmptyState';
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

const PURCHASE_COLUMNS: Column<Purchase>[] = [
  {
    key: 'date',
    header: 'Дата',
    cell: (p) => (
      <span className="whitespace-nowrap tabular-nums text-muted-foreground">
        {formatDate(p.transaction?.date ?? p.createdAt)}
      </span>
    ),
    className: 'w-[120px]',
  },
  { key: 'lines', header: 'Позиций', align: 'right', cell: (p) => p.lines.length, className: 'w-[100px]' },
  {
    key: 'note',
    header: 'Комментарий',
    cell: (p) => (
      <span className="block truncate text-muted-foreground" title={p.note ?? ''}>
        {p.note ?? '—'}
      </span>
    ),
    className: 'w-full max-w-0',
  },
  {
    key: 'total',
    header: 'Сумма',
    align: 'right',
    cell: (p) => <Money value={purchaseTotal(p)} className="font-medium" />,
    className: 'w-[160px]',
  },
];

const purchaseCard = (p: Purchase) => (
  <div className="flex items-baseline justify-between gap-3">
    <div className="min-w-0">
      <div className="font-medium tabular-nums">{formatDate(p.transaction?.date ?? p.createdAt)}</div>
      <div className="truncate text-xs text-muted-foreground">
        {p.lines.length} поз.{p.note ? ` · ${p.note}` : ''}
      </div>
    </div>
    <Money value={purchaseTotal(p)} className="font-semibold" />
  </div>
);

export default function SupplierCardPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();
  const { current } = useCurrentWorkspace();
  const wsId = current?.id ?? null;

  const suppliersQ = useCounterparties(wsId, '', false, 'SUPPLIER');
  const supplier = suppliersQ.data?.find((c) => c.id === id) ?? null;

  const purchasesQ = usePurchases(wsId, id);
  const purchases = purchasesQ.data ?? [];
  // Общая сумма закупок — Decimal-сложение (деньги никогда через float).
  const total = toMoneyString(purchases.reduce((acc, p) => add(acc, purchaseTotal(p)), D(0)));

  if (!current) return null;

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
              Все операции поставщика <ArrowRight className="h-4 w-4" />
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
        <KpiRow loading={purchasesQ.isLoading} count={2}>
          <KpiCard label="Сумма закупок" value={<Money value={total} />} />
          <KpiCard label="Закупок" value={String(purchases.length)} />
        </KpiRow>

        {/* Закупки поставщика: строка открывает окно закупки на экране закупок. */}
        <SectionCard title="Закупки">
          <DataTable
            data={purchases}
            columns={PURCHASE_COLUMNS}
            rowKey={(p) => p.id}
            onRowClick={(p) =>
              router.push(`/purchases?purchase=${p.id}` as Parameters<typeof router.push>[0])
            }
            loading={purchasesQ.isLoading}
            error={purchasesQ.error}
            onRetry={() => purchasesQ.refetch()}
            empty={
              <EmptyState
                icon={Package}
                title="Закупок нет"
                hint="У этого поставщика пока нет закупок."
              />
            }
            mobileCards={purchaseCard}
            footer={purchases.length > 0 ? { note: 'Итого', total: <Money value={total} /> } : undefined}
          />
        </SectionCard>
      </div>
    </>
  );
}
