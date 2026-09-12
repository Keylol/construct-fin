'use client';

import Link from 'next/link';
import { Money } from '@/components/ui/Money';
import { Card } from '@/components/ui/Card';
import { SectionCard } from '@/components/ui/SectionCard';
import { ErrorState } from '@/components/ui/ErrorState';
import { KpiCard } from '@/components/ui/KpiCard';
import { KpiRow } from '@/components/ui/KpiRow';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useBalanceReport } from '@/hooks/useReports';
import { formatDateTime } from '@/lib/dates';
import { cn } from '@/lib/cn';
import { D } from '@construct/shared';

/**
 * Управленческий баланс «на сейчас»: активы (деньги, дебиторская задолженность
 * по закрытым заказам, запасы) против обязательств (авансы клиентов, налог
 * к уплате); капитал — разница. Третий отчёт классической тройки.
 */
export default function BalancePage() {
  const { current } = useCurrentWorkspace();
  const wsId = current?.id ?? null;
  const query = useBalanceReport(wsId);

  if (!current) return null;

  const b = query.data;

  return (
    <div className="space-y-6 px-6 py-6">
      <p className="max-w-3xl text-sm text-muted-foreground">
        Снимок финансового положения на текущий момент. Активы — чем владеет бизнес;
        обязательства — что бизнес должен; капитал — разница между ними.
      </p>

      {query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : query.isLoading || !b ? (
        <KpiRow loading count={3}>
          {null}
        </KpiRow>
      ) : (
        <>
          {/* Итоги */}
          <KpiRow count={3}>
            <KpiCard label="Активы" value={<Money value={b.assets.total} />} />
            <KpiCard label="Обязательства" value={<Money value={b.liabilities.total} />} />
            <KpiCard
              label="Капитал"
              value={<Money value={b.equity} />}
              tone={D(b.equity).gte(0) ? 'positive' : 'negative'}
              hint="Активы − Обязательства"
            />
          </KpiRow>

          <div className="grid gap-4 md:grid-cols-2">
            {/* Активы */}
            <SectionCard
              title="Активы"
              aside={<Money value={b.assets.total} className="text-sm font-semibold text-foreground" />}
            >
              <div className="divide-y divide-border/60">
                <BalanceRow
                  label="Денежные средства"
                  value={b.assets.cash.total}
                  href="/accounts"
                />
                {/* Детализация по счетам — приглушённо, вторым уровнем. */}
                {b.assets.cash.accounts.map((a) => (
                  <BalanceRow key={a.id} label={a.name} value={a.balance} nested />
                ))}
                <BalanceRow
                  label="Дебиторская задолженность"
                  hint="по закрытым заказам"
                  value={b.assets.receivables}
                  href="/reports/receivables"
                />
                <BalanceRow label="Запасы" value={b.assets.inventory} href="/warehouse" />
              </div>
            </SectionCard>

            {/* Обязательства + капитал */}
            <div className="space-y-4">
              <SectionCard
                title="Обязательства"
                aside={<Money value={b.liabilities.total} className="text-sm font-semibold text-foreground" />}
              >
                <div className="divide-y divide-border/60">
                  <BalanceRow
                    label="Авансы клиентов"
                    hint="предоплаты по незакрытым заказам"
                    value={b.liabilities.customerAdvances}
                    href="/orders"
                  />
                  <BalanceRow
                    label="Налог к уплате (АУСН)"
                    value={b.liabilities.taxDue}
                    href="/tax"
                  />
                </div>
              </SectionCard>

              <Card className="!p-0 overflow-hidden">
                <header className="flex items-baseline justify-between px-4 py-3">
                  <h3 className="font-medium">Капитал</h3>
                  <span
                    className={cn(
                      'num text-sm font-semibold',
                      D(b.equity).lt(0) && 'text-destructive',
                    )}
                  >
                    <Money value={b.equity} />
                  </span>
                </header>
              </Card>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            Данные на {formatDateTime(b.asOf)}. Дебиторская задолженность здесь — только по
            закрытым заказам (выручка признана); долги по незакрытым заказам смотрите в
            отчёте «Дебиторская задолженность», их предоплаты учтены как авансы клиентов.
          </p>
        </>
      )}
    </div>
  );
}

function BalanceRow({
  label,
  value,
  hint,
  href,
  nested,
}: {
  label: string;
  value: string;
  hint?: string;
  href?: string;
  nested?: boolean;
}) {
  const inner = (
    <>
      <span className={cn('min-w-0 truncate', nested && 'pl-5 text-muted-foreground')}>
        {label}
        {hint && <span className="ml-2 text-xs text-muted-foreground">{hint}</span>}
      </span>
      <span
        className={cn(
          'num shrink-0',
          nested ? 'text-muted-foreground' : 'font-medium',
          // Минус в бухгалтерии виден дважды — скобками и цветом (решение №13):
          // счёт в минусе не должен теряться среди обычных строк.
          D(value).lt(0) && 'text-destructive',
        )}
      >
        <Money value={value} />
      </span>
    </>
  );
  const cls = 'flex items-baseline justify-between gap-3 px-4 py-2.5 text-sm';
  if (href && !nested) {
    return (
      <Link
        href={href as Parameters<typeof Link>[0]['href']}
        className={cn(cls, 'transition-colors hover:bg-secondary')}
      >
        {inner}
      </Link>
    );
  }
  return <div className={cls}>{inner}</div>;
}
