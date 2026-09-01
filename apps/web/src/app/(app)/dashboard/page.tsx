'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, ReceiptText, Wallet } from '@/components/ui/icons';
import { Money } from '@/components/ui/Money';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useTransactions, useTransactionSummary } from '@/hooks/useTransactions';
import { useAccounts } from '@/hooks/useAccounts';
import { useCategories } from '@/hooks/useCategories';
import { useCounterparties } from '@/hooks/useCounterparties';
import { useMarginReport, useReceivables } from '@/hooks/useTradeReports';
import { useStockValue, useWarehouse } from '@/hooks/useWarehouse';
import { useCashflowReport } from '@/hooks/useReports';
import { useTotalCash } from '@/hooks/useTotalCash';
import { PageHeader } from '@/components/ui/PageHeader';
import { KpiCard } from '@/components/ui/KpiCard';
import { Sparkline } from '@/components/ui/Sparkline';
import { AnimatedNumber } from '@/components/ui/AnimatedNumber';
import { StatusDot } from '@/components/ui/StatusDot';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { Button } from '@/components/ui/Button';
import { TransactionListItem } from '@/components/transactions/TransactionListItem';
import { rangeFor } from '@/lib/periods';
import { txDrilldownHref } from '@/lib/tx-filters';
import { formatDayLabel } from '@/lib/dates';
import { plural } from '@/lib/plural';
import { formatRub } from '@construct/shared';
import { cn } from '@/lib/cn';
import type { Transaction } from '@/lib/types';

/** Дневные группы для ленты: соседние операции одного дня — под один заголовок. */
function groupByDay(items: Transaction[]): { label: string; items: Transaction[] }[] {
  const groups: { label: string; items: Transaction[] }[] = [];
  for (const tx of items) {
    const label = formatDayLabel(tx.date);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(tx);
    else groups.push({ label, items: [tx] });
  }
  return groups;
}

export default function DashboardPage() {
  const router = useRouter();
  const { current } = useCurrentWorkspace();
  const wsId = current?.id ?? null;
  const range = useMemo(() => rangeFor('month'), []);
  const summary = useTransactionSummary(wsId, range);
  const recent = useTransactions(wsId, { ...range, limit: 8 });
  // Владельческие KPI: каждый хук грузится независимо (частичная загрузка плиток).
  const cash = useTotalCash(wsId);
  const receivables = useReceivables(wsId);
  const stock = useStockValue(wsId);
  const margin = useMarginReport('by-product', wsId, range);
  // Тренд 12 мес для sparkline доход/расход (месячные бакеты ОДДС, consolidated).
  const trendRange = useMemo(() => ({ preset: 'last-12m' as const }), []);
  const cashflowTrend = useCashflowReport(wsId, trendRange, null);
  const warehouse = useWarehouse(wsId);
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
            hint="Выберите или создайте пространство."
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

  // Sparkline-тренды (№24): месячные бакеты ОДДС; Number — только для геометрии.
  const trendPoints = cashflowTrend.data?.series[0]?.points ?? [];
  const inflowTrend = trendPoints.map((p) => Number(p.inflow));
  const outflowTrend = trendPoints.map((p) => Number(p.outflow));

  // «Требует внимания» (№25): рабочая очередь владельца — каждый пункт ведёт
  // в место исправления. Виджет не рендерится, когда всё чисто.
  const noCostItems = (warehouse.data ?? []).filter(
    (w) => Number(w.qty) > 0 && Number(w.avgCost) === 0,
  );
  const overdueClients = (receivables.data?.clients ?? []).filter(
    (c) => Number(c.overdueByPlan) > 0,
  );
  const attention: { key: string; href: string; tone: 'warning' | 'destructive'; text: string }[] =
    [];
  if (hasOverdue) {
    attention.push({
      key: 'overdue',
      href: '/reports/receivables',
      tone: 'destructive',
      text: `Просроченные платежи: ${formatRub(overdueTotal)} у ${overdueClients.length} ${plural(overdueClients.length, 'клиента', 'клиентов', 'клиентов')}`,
    });
  }
  if (noCostItems.length > 0) {
    attention.push({
      key: 'no-cost',
      href: '/warehouse',
      tone: 'warning',
      text: `Позиции склада без себестоимости: ${noCostItems.length} — маржа по ним считается оценкой`,
    });
  }

  return (
    <>
      <PageHeader title="Главная" description="Сводка за текущий месяц" />

      <div className="space-y-6 px-6 py-6">
        {/* Bento (№23): «Всего денег» — главная цифра, вдвое шире остальных. */}
        <div className="stagger grid gap-4 sm:grid-cols-3">
          {cash.isLoading || cash.total == null ? (
            <Skeleton className="h-[124px] sm:col-span-2" />
          ) : (
            <KpiCard
              label="Денежные средства"
              value={<AnimatedNumber value={cash.total} />}
              size="display"
              href="/accounts"
              className="sm:col-span-2"
            />
          )}

          {/* Дебиторка — свой loading-скелетон; ошибка/нет данных → 0 ₽. */}
          {receivables.isLoading ? (
            <Skeleton className="h-[124px]" />
          ) : (
            <KpiCard
              label="Дебиторская задолженность"
              value={<AnimatedNumber value={receivables.data?.totalDue ?? '0'} />}
              tone={hasOverdue ? 'negative' : 'neutral'}
              hint={hasOverdue ? `в т.ч. просрочено ${formatRub(overdueTotal)}` : undefined}
              href="/reports/receivables"
            />
          )}

          {/* Денежный поток за месяц + тренд 12 мес (№24). */}
          {summary.isLoading || !summary.data ? (
            <>
              <Skeleton className="h-[124px]" />
              <Skeleton className="h-[124px]" />
              <Skeleton className="h-[124px]" />
            </>
          ) : (
            <>
              <KpiCard
                label="Доходы"
                value={<AnimatedNumber value={summary.data.income} />}
                tone="positive"
                href={txDrilldownHref({ from: range.from, to: range.to, type: 'INCOME' })}
                chart={
                  inflowTrend.length > 1 ? (
                    <Sparkline values={inflowTrend} className="text-success" />
                  ) : undefined
                }
              />
              <KpiCard
                label="Расходы"
                value={<AnimatedNumber value={summary.data.expense} />}
                tone="negative"
                href={txDrilldownHref({ from: range.from, to: range.to, type: 'EXPENSE' })}
                chart={
                  outflowTrend.length > 1 ? (
                    <Sparkline values={outflowTrend} className="text-destructive" />
                  ) : undefined
                }
              />
              <KpiCard
                label="Чистый денежный поток"
                value={<AnimatedNumber value={summary.data.net} />}
                href="/reports/cashflow"
              />
            </>
          )}

          {/* Склад в деньгах. */}
          {stock.isLoading ? (
            <Skeleton className="h-[92px]" />
          ) : (
            <KpiCard
              label="Стоимость запасов"
              value={<AnimatedNumber value={stock.data?.value ?? '0'} />}
              href="/warehouse"
            />
          )}

          {/* Маржа за текущий месяц (по товарам). */}
          {margin.isLoading ? (
            <Skeleton className="h-[92px]" />
          ) : (
            <KpiCard
              label="Валовая прибыль за месяц"
              value={<AnimatedNumber value={margin.data?.totals.margin ?? '0'} />}
              hint={margin.data ? `${margin.data.totals.marginPct}%` : undefined}
              href="/reports/margin"
              className="sm:col-span-2"
            />
          )}
        </div>

        {/* Требует внимания (№25): дашборд — рабочий стол, а не витрина. */}
        {attention.length > 0 && (
          <section>
            <h2 className="mb-3 text-base font-semibold tracking-tight">Требует внимания</h2>
            <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
              {attention.map((a) => (
                <Link
                  key={a.key}
                  href={a.href as Parameters<typeof Link>[0]['href']}
                  className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-secondary"
                >
                  <StatusDot tone={a.tone} label={a.text} />
                  <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                </Link>
              ))}
            </div>
          </section>
        )}

        {topDebtors.length > 0 && (
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-semibold tracking-tight">Крупнейшие дебиторы</h2>
              <Button variant="link" asChild>
                <Link href="/reports/receivables">
                  Вся задолженность
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
                // Aging-полоса (№26): доли долга по давности. Number — только
                // для геометрии сегментов, суммы наружу — Decimal-строками.
                const dueNum = Number(c.due) || 1;
                const seg = (v: string) => Math.max(0, Math.min(100, (Number(v) / dueNum) * 100));
                const aging = [
                  { key: '0-30', width: seg(c.buckets['0-30']), className: 'bg-primary/35' },
                  { key: '30-60', width: seg(c.buckets['30-60']), className: 'bg-warning' },
                  { key: '60+', width: seg(c.buckets['60+']), className: 'bg-destructive' },
                ].filter((s) => s.width > 0);
                return (
                  <Link
                    key={c.clientId ?? c.clientName}
                    href={href}
                    className="block px-4 py-3 transition-colors hover:bg-accent/50"
                  >
                    <span className="flex items-center justify-between gap-3">
                      <span className="truncate text-sm font-medium">{c.clientName}</span>
                      <span className="flex shrink-0 items-center gap-3">
                        {overdue && (
                          <span className="text-xs text-destructive">
                            просрочено {formatRub(c.overdueByPlan)}
                          </span>
                        )}
                        <Money value={c.due} className="text-sm font-semibold" />
                      </span>
                    </span>
                    {aging.length > 0 && (
                      <span
                        className="mt-2 flex h-1 w-full overflow-hidden rounded-full bg-border/60"
                        title="Давность долга: синий — до 30 дн, янтарь — 30–60, красный — 60+"
                      >
                        {aging.map((s) => (
                          <span
                            key={s.key}
                            className={cn('h-full', s.className)}
                            style={{ width: `${s.width}%` }}
                          />
                        ))}
                      </span>
                    )}
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
                title="Пока нет операций"
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
              {/* Группировка по дням (№27): заголовок дня между операциями. */}
              {groupByDay(recent.data?.items ?? []).map((g) => (
                <div key={g.label}>
                  <div className="bg-sunken px-4 py-1.5 text-xs font-medium text-muted-foreground">
                    {g.label}
                  </div>
                  <div className="divide-y divide-border">
                    {g.items.map((tx) => (
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
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  );
}
