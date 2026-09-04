'use client';

import Link from 'next/link';
import { Alarm, ArrowRight, Check } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { StatusDot } from '@/components/ui/StatusDot';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useHealthChecks, type HealthCheck } from '@/hooks/useHealthChecks';
import { cn } from '@/lib/cn';

/**
 * «Здоровье» — что в учёте не доделано прямо сейчас (P2.9 аудита 13.08).
 *
 * Дашборд показывает только сработавшие проверки и только сверху, среди цифр
 * месяца. Здесь — весь список, включая пройденные: перед сдачей месяца важно
 * видеть не только «что горит», но и что проверено и чисто.
 */
export default function HealthPage() {
  const { current } = useCurrentWorkspace();
  const wsId = current?.id ?? null;
  const { checks, failing, isLoading } = useHealthChecks(wsId);

  if (!current) {
    return (
      <>
        <PageHeader title="Здоровье" />
        <div className="p-6">
          <EmptyState
            icon={Alarm}
            title="Нет активного пространства"
            hint="Выберите или создайте пространство."
          />
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Здоровье"
        description={
          <>
            Что в учёте не доделано: необработанные строки банка, заказы без закрытия,
            просрочки, минусовые остатки и позиции без себестоимости. Каждая строка ведёт
            туда, где это исправляют.
          </>
        }
      />

      <div className="space-y-6 px-6 py-6">
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              {failing.length === 0
                ? 'Все проверки пройдены — учёт сведён.'
                : `Требует внимания: ${failing.length} из ${checks.length}.`}
            </p>

            <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
              {checks.map((c) => (
                <CheckRow key={c.key} check={c} />
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}

function CheckRow({ check }: { check: HealthCheck }) {
  const ok = check.tone === 'ok';
  return (
    <Link
      href={check.href as Parameters<typeof Link>[0]['href']}
      className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-secondary/40"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {ok ? (
            <Check className="h-3.5 w-3.5 shrink-0 text-success" />
          ) : (
            <StatusDot
              tone={check.tone === 'destructive' ? 'destructive' : 'warning'}
              label=""
              className="shrink-0"
            />
          )}
          <span className={cn('font-medium', ok && 'text-muted-foreground')}>{check.title}</span>
        </div>
        <p className="mt-0.5 pl-5 text-sm text-muted-foreground">{check.detail}</p>
      </div>
      <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
    </Link>
  );
}
