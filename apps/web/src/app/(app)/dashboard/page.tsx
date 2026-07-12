'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, ReceiptText, Wallet } from '@/components/ui/icons';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useTransactions, useTransactionSummary } from '@/hooks/useTransactions';
import { useAccounts } from '@/hooks/useAccounts';
import { useCategories } from '@/hooks/useCategories';
import { useCounterparties } from '@/hooks/useCounterparties';
import { useMarginReport, useReceivables } from '@/hooks/useTradeReports';
import { useStockValue } from '@/hooks/useWarehouse';
import { PageHeader } from '@/components/ui/PageHeader';
import { KpiCard } from '@/components/ui/KpiCard';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { Button } from '@/components/ui/Button';
import { TransactionListItem } from '@/components/transactions/TransactionListItem';
import { rangeFor } from '@/lib/periods';
import { formatRub } from '@construct/shared';

export default function DashboardPage() {
  const router = useRouter();
  const { current } = useCurrentWorkspace();
  const wsId = current?.id ?? null;
  const range = useMemo(() => rangeFor('month'), []);
  const summary = useTransactionSummary(wsId, range);
  const recent = useTransactions(wsId, { ...range, limit: 5 });
  // Владельческие KPI: каждый хук грузится независимо (частичная загрузка плиток).
  const receivables = useReceivables(wsId);
  const stock = useStockValue(wsId);
  const margin = useMarginReport('by-product', wsId, range);
  const accounts = useAccounts(wsId);
  const incomeCats = useCategories(wsId, 'INCOME');
  const expenseCats = useCategories(wsId, 'EXPENSE');
  const counterparties = useCounterparties(wsId);

  const allCats = [...(incomeCats.data ?? []), ...(expenseCats.data ?? [])];
  const accountById = Object.fromEntries((accounts.data ?? []).map((a) => [a.id, a]));
  const categoryById = Object.fromEntries(allCats.map((c) => [c.id, c]));
  const counterpartyById = Object.fromEntries(
    (counterparties.data ?? []).map((c) => [c.id, c]),
  );

  if (!current) {
    return (
      <>
        <PageHeader title="Главная" />
        <div className="p-6">
          <EmptyState
            icon={Wallet}
            title="Нет активного пространства"
            hint="Создайте первое пространство через переключатель в меню."
          />
        </div>
      </>
    );
  }

  // Дебиторка: просрочка > 0 → красный тон + hint. Сравнение числовое, деньги — строкой.
  const overdueTotal = receivables.data?.overdueByPlanTotal ?? '0';
  const hasOverdue = Number(overdueTotal) > 0;

  // Топ должников — первые 5 по сумме к получению (сортируем копию, деньги строкой).
  const topDebtors = [...(receivables.data?.clients ?? [])]
    .filter((c) => Number(c.due) > 0)
    .sort((a, b) => Number(b.due) - Number(a.due))
    .slice(0, 5);

  return (
    <>
      <PageHeader title="Главная" description="Сводка за текущий месяц" />

      <div className="space-y-6 px-6 py-6">
        <div className="stagger grid gap-4 sm:grid-cols-3">
          {/* Денежный поток за месяц — из одного summary-запроса. */}
          {summary.isLoading || !summary.data ? (
            <>
              <Skeleton className="h-[92px]" />
              <Skeleton className="h-[92px]" />
              <Skeleton className="h-[92px]" />
            </>
          ) : (
            <>
              <KpiCard
                label="Доходы"
                value={formatRub(summary.data.income)}
                tone="positive"
              />
              <KpiCard
                label="Расходы"
                value={formatRub(summary.data.expense)}
                tone="negative"
              />
              <KpiCard label="Чистый денежный поток" value={formatRub(summary.data.net)} />
            </>
          )}

          {/* Дебиторка — свой loading-скелетон; ошибка/нет данных → 0 ₽. */}
          {receivables.isLoading ? (
            <Skeleton className="h-[92px]" />
          ) : (
            <KpiCard
              label="Дебиторка"
              value={formatRub(receivables.data?.totalDue ?? '0')}
              tone={hasOverdue ? 'negative' : 'neutral'}
              hint={hasOverdue ? `в т.ч. просрочено ${formatRub(overdueTotal)}` : undefined}
              href="/reports/receivables"
            />
          )}

          {/* Склад в деньгах. */}
          {stock.isLoading ? (
            <Skeleton className="h-[92px]" />
          ) : (
            <KpiCard
              label="Склад в деньгах"
              value={formatRub(stock.data?.value ?? '0')}
              href="/warehouse"
            />
          )}

          {/* Маржа за текущий месяц (по товарам). */}
          {margin.isLoading ? (
            <Skeleton className="h-[92px]" />
          ) : (
            <KpiCard
              label="Маржа за месяц"
              value={formatRub(margin.data?.totals.margin ?? '0')}
              hint={margin.data ? `${margin.data.totals.marginPct}%` : undefined}
              href="/reports/margin"
            />
          )}
        </div>

        {topDebtors.length > 0 && (
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-semibold tracking-tight">Топ должников</h2>
              <Button variant="link" asChild>
                <Link href="/reports/receivables">
                  Вся дебиторка
                  <ArrowRight className="ml-1 h-3.5 w-3.5" />
                </Link>
              </Button>
            </div>
            <div className="overflow-hidden rounded-lg border border-border bg-card divide-y divide-border">
              {topDebtors.map((c, idx) => {
                const overdue = Number(c.overdueByPlan) > 0;
                // Клик по должнику ведёт в карточку клиента (роут есть); без
                // clientId (сводная «Без клиента») — в общий отчёт дебиторки.
                const href = (
                  c.clientId ? `/clients/${c.clientId}` : '/reports/receivables'
                ) as Parameters<typeof Link>[0]['href'];
                return (
                  <Link
                    key={c.clientId ?? c.clientName}
                    href={href}
                    className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-accent/50"
                  >
                    <span className="truncate text-sm font-medium">{c.clientName}</span>
                    <span className="flex shrink-0 items-center gap-3">
                      {overdue && (
                        <span className="text-xs text-destructive">
                          просрочено {formatRub(c.overdueByPlan)}
                        </span>
                      )}
                      <span className="num text-sm font-semibold">{formatRub(c.due)}</span>
                    </span>
                  </Link>
                );
              })}
            </div>
          </section>
        )}

        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold tracking-tight">Последние операции</h2>
            <Button variant="link" asChild>
              <Link href="/transactions">
                Все
                <ArrowRight className="ml-1 h-3.5 w-3.5" />
              </Link>
            </Button>
          </div>

          {recent.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : recent.data && recent.data.items.length === 0 ? (
            <div className="rounded-lg border border-border bg-card">
              <EmptyState
                icon={ReceiptText}
                title="Пока операций нет"
                hint="Перейдите в раздел «Операции» и добавьте первую."
                action={
                  <Button asChild>
                    <Link href="/transactions">Перейти к операциям</Link>
                  </Button>
                }
              />
            </div>
          ) : (
            <div className="overflow-hidden rounded-lg border border-border bg-card divide-y divide-border">
              {(recent.data?.items ?? []).map((tx) => (
                <TransactionListItem
                  key={tx.id}
                  tx={tx}
                  account={tx.accountId ? accountById[tx.accountId] : undefined}
                  category={tx.categoryId ? categoryById[tx.categoryId] : undefined}
                  counterparty={
                    tx.counterpartyId ? counterpartyById[tx.counterpartyId] : undefined
                  }
                  onClick={() => {
                    router.push('/transactions');
                  }}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  );
}
