'use client';

import Link from 'next/link';
import type { HealthCheck } from '@/hooks/useHealthChecks';
import { ArrowRight, Check } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/lib/cn';

/**
 * «Сделать сейчас» — рабочая очередь на главной.
 *
 * Первое, что видно при входе, и это осознанно: пока очередь не пуста, цифры
 * месяца неполные — деньги не разнесены, выручка по незакрытым заказам не
 * признана. Каждая строка говорит, что случилось и куда идти; действие названо
 * глаголом, а не термином учёта.
 *
 * Источник — те же проверки, что на странице «Здоровье», поэтому две страницы
 * не расходятся в оценке состояния учёта.
 */

/** Что делать по каждой проверке. Ключи — из useHealthChecks. */
const ACTION: Record<string, string> = {
  inbox: 'Разнести',
  'closable-orders': 'Закрыть заказы',
  overdue: 'Посмотреть долги',
  'negative-accounts': 'Найти пропажу',
  'no-cost': 'Проставить цены',
};

export function WorkQueue({ checks, loading }: { checks: HealthCheck[]; loading?: boolean }) {
  if (loading) return <Skeleton className="h-[140px]" />;

  if (checks.length === 0) {
    return (
      <section className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-success/10 text-success">
          <Check className="h-3.5 w-3.5" aria-hidden />
        </span>
        <div>
          <p className="text-sm font-medium text-foreground">Учёт сведён</p>
          <p className="text-xs text-muted-foreground">
            Деньги разнесены, оплаченные заказы закрыты, просрочек нет. Цифры ниже полные.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-base font-semibold tracking-tight">Сделать сейчас</h2>
        <p className="text-xs text-muted-foreground">Пока не сделано, цифры месяца неполные</p>
      </div>
      <ol className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
        {checks.map((c) => (
          <li key={c.key}>
            <Link
              href={c.href as Parameters<typeof Link>[0]['href']}
              className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-secondary"
            >
              <span
                aria-hidden
                className={cn(
                  'h-2 w-2 shrink-0 rounded-full',
                  c.tone === 'destructive' ? 'bg-destructive' : 'bg-warning',
                )}
              />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-foreground">{c.title}</span>
                <span className="block truncate text-xs text-muted-foreground">{c.detail}</span>
              </span>
              <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-primary">
                {ACTION[c.key] ?? 'Открыть'}
                <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
