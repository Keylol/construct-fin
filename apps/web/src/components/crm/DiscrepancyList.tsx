'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { Money } from '@/components/ui/Money';
import { Skeleton } from '@/components/ui/Skeleton';
import { ErrorState } from '@/components/ui/ErrorState';
import { EmptyState } from '@/components/ui/EmptyState';
import { StatusDot } from '@/components/ui/StatusDot';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Check, ChevronDown, ChevronUp } from '@/components/ui/icons';
import { formatDate } from '@/lib/dates';
import { plural } from '@/lib/plural';
import { useCrmDiscrepancies } from '@/hooks/useCrm';
import type { CrmDiscrepancyCheck, CrmDiscrepancyItem } from '@/lib/types';

/** Горизонт: квартал по умолчанию, год и всё время — когда разбирают хвосты. */
const HORIZONS = [
  { value: '90', label: '90 дней' },
  { value: '365', label: 'Год' },
  { value: '0', label: 'Всё время' },
] as const;

/**
 * «Что потерялось между amoCRM и учётом».
 *
 * Смысл интеграции — чтобы ни одна продажа не выпала: выигранная сделка без
 * заказа значит непризнанную выручку, закрытая в CRM сделка с недоплатой —
 * дебиторку, которую никто не ждёт. Проверки показываются всегда, включая
 * пройденные: видеть, что проверено и чисто, так же важно.
 */
export function DiscrepancyList({ wsId, crmHref }: { wsId: string; crmHref: string }) {
  const [horizon, setHorizon] = useState<string>('90');
  const data = useCrmDiscrepancies(wsId, Number(horizon));
  const [opened, setOpened] = useState<string[]>([]);

  const checks = data.data?.checks ?? [];
  const failing = checks.filter((c) => c.count > 0);

  if (data.isError) return <ErrorState error={data.error} onRetry={() => data.refetch()} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Проверки идут по обе стороны: продажа, закрытая в amoCRM, должна стать заказом с выручкой,
          а закрытый заказ — закрытой сделкой. Всё, что не сошлось, видно здесь и в очереди «Сделать
          сейчас» на главной.
        </p>
        <SegmentedControl
          value={horizon}
          onChange={setHorizon}
          ariaLabel="За какой период считать расхождения"
          options={HORIZONS.map((h) => ({ value: h.value, label: h.label }))}
        />
      </div>

      {data.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
      ) : failing.length === 0 ? (
        <EmptyState
          icon={Check}
          title="Расхождений нет"
          hint="Каждая выигранная сделка стала заказом, закрытые заказы закрыты и в CRM, суммы сошлись."
        />
      ) : (
        <div className="space-y-2">
          {failing.map((check) => (
            <CheckCard
              key={check.key}
              check={check}
              crmHref={crmHref}
              open={opened.includes(check.key)}
              onToggle={() =>
                setOpened((prev) =>
                  prev.includes(check.key)
                    ? prev.filter((k) => k !== check.key)
                    : [...prev, check.key],
                )
              }
            />
          ))}
        </div>
      )}

      {/* Пройденные проверки не прячем: «проверено и чисто» — тоже ответ. */}
      {!data.isLoading && checks.length > failing.length && (
        <div className="rounded-md border border-border bg-card p-3 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">Сошлось:</span>{' '}
          {checks
            .filter((c) => c.count === 0)
            .map((c) => c.title.toLowerCase())
            .join(' · ')}
        </div>
      )}
    </div>
  );
}

function CheckCard({
  check,
  crmHref,
  open,
  onToggle,
}: {
  check: CrmDiscrepancyCheck;
  crmHref: string;
  open: boolean;
  onToggle: () => void;
}) {
  const hasMore = check.count > check.items.length;
  return (
    <div className="rounded-md border border-border bg-card">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-start justify-between gap-3 p-3 text-left"
      >
        <div className="min-w-0">
          <StatusDot
            tone={check.tone === 'destructive' ? 'destructive' : 'warning'}
            label={check.title}
          />
          <div className="mt-1 text-xs text-muted-foreground">{check.hint}</div>
        </div>
        <div className="flex shrink-0 items-center gap-3 text-sm">
          <div className="text-right">
            <div className="font-semibold tabular-nums">{check.count}</div>
            {Number(check.sum) > 0 && (
              <div className="text-xs text-muted-foreground">
                <Money value={check.sum} />
              </div>
            )}
          </div>
          {check.items.length > 0 &&
            (open ? (
              <ChevronUp className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ))}
        </div>
      </button>

      {open && check.items.length > 0 && (
        <div className="border-t border-border">
          {check.items.map((item, i) => (
            <ItemRow key={`${item.dealId ?? item.orderId}-${i}`} item={item} crmHref={crmHref} />
          ))}
          {hasMore && (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              Показаны первые {check.items.length} из {check.count}
              {' — '}
              {plural(check.count - check.items.length, 'остальная', 'остальные', 'остальных')}{' '}
              {plural(check.count - check.items.length, 'строка', 'строки', 'строк')} в списке
              сделок.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Строка расхождения: слева что не сошлось, справа куда идти чинить. */
function ItemRow({ item, crmHref }: { item: CrmDiscrepancyItem; crmHref: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2 text-sm last:border-b-0">
      <div className="min-w-0">
        <div className="truncate">
          {item.dealName ?? item.clientName ?? item.orderNumber}
          {item.dealStatus && (
            <span className="ml-2 text-xs text-muted-foreground">{item.dealStatus}</span>
          )}
        </div>
        <div className="text-xs text-muted-foreground">
          {formatDate(item.date)}
          {item.orderNumber && ` · заказ ${item.orderNumber}`}
          {item.clientName && item.dealName && ` · ${item.clientName}`}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <Money value={item.amount} />
        {item.orderId ? (
          <Button variant="secondary" size="sm" asChild>
            <Link href={{ pathname: '/orders', query: { order: item.orderId } }}>Заказ</Link>
          </Button>
        ) : (
          <Button variant="secondary" size="sm" asChild>
            <Link href={{ pathname: crmHref, query: { tab: 'all', q: item.dealName ?? '' } }}>
              Найти сделку
            </Link>
          </Button>
        )}
      </div>
    </div>
  );
}
