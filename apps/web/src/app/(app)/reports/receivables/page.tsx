'use client';

import { useState } from 'react';
import { BarChart3, ChevronRight } from 'lucide-react';
import { formatRub } from '@construct/shared';
import { Card } from '@/components/ui/Card';
import { KpiCard } from '@/components/ui/KpiCard';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import { FilterBar } from '@/components/ui/FilterBar';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useReceivables } from '@/hooks/useTradeReports';
import type { AgingBucketKey } from '@/lib/types';
import { cn } from '@/lib/cn';

const BUCKET_TONE: Record<AgingBucketKey, string> = {
  '0-30': 'text-foreground',
  '30-60': 'text-warning',
  '60+': 'text-destructive',
};

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

export default function ReceivablesReportPage() {
  const ws = useCurrentWorkspace();
  const wsId = ws.currentId;
  const today = new Date().toISOString().slice(0, 10);
  const [asOf, setAsOf] = useState(today);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const query = useReceivables(wsId, new Date(asOf).toISOString());

  if (!wsId) {
    return (
      <div className="p-6">
        <EmptyState
          icon={BarChart3}
          title="Нет активного пространства"
          hint="Выберите или создайте пространство."
        />
      </div>
    );
  }

  const data = query.data;
  const clients = data?.clients ?? [];

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <>
      <FilterBar>
        <label className="flex flex-col text-xs text-muted-foreground">
          <span className="pb-1">На дату</span>
          <Input
            type="date"
            value={asOf}
            onChange={(e) => setAsOf(e.target.value)}
            className="h-9 w-[160px]"
          />
        </label>
      </FilterBar>

      <div className="space-y-4 px-6 py-4">
        {query.isLoading ? (
          <div className="grid gap-3 sm:grid-cols-4">
            <Skeleton className="h-[88px]" />
            <Skeleton className="h-[88px]" />
            <Skeleton className="h-[88px]" />
            <Skeleton className="h-[88px]" />
          </div>
        ) : query.isError ? (
          <p className="text-sm text-destructive">Не удалось загрузить отчёт.</p>
        ) : data ? (
          <div className="stagger grid gap-4 sm:grid-cols-4">
            <KpiCard label="Всего к получению" value={formatRub(data.totalDue)} />
            <KpiCard label="0–30 дней" value={formatRub(data.buckets['0-30'])} tone="positive" />
            <KpiCard label="30–60 дней" value={formatRub(data.buckets['30-60'])} tone="warning" />
            <KpiCard label="60+ дней" value={formatRub(data.buckets['60+'])} tone="negative" />
          </div>
        ) : null}

        {data && (
          <Card className="overflow-x-auto !p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-border">
                <tr className="text-left text-xs uppercase text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Клиент</th>
                  <th className="px-4 py-2 text-right font-medium">0–30</th>
                  <th className="px-4 py-2 text-right font-medium">30–60</th>
                  <th className="px-4 py-2 text-right font-medium">60+</th>
                  <th className="px-4 py-2 text-right font-medium">К получению</th>
                </tr>
              </thead>
              <tbody>
                {clients.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                      Нет неоплаченных заказов на эту дату.
                    </td>
                  </tr>
                ) : (
                  clients.map((c) => {
                    const id = c.clientId ?? 'none';
                    const open = expanded.has(id);
                    return (
                      <FragmentRow
                        key={id}
                        open={open}
                        onToggle={() => toggle(id)}
                        client={c}
                      />
                    );
                  })
                )}
              </tbody>
            </table>
          </Card>
        )}
      </div>
    </>
  );
}

function FragmentRow({
  client,
  open,
  onToggle,
}: {
  client: import('@/lib/types').ReceivableClientRow;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        className="cursor-pointer border-b border-border last:border-0 hover:bg-secondary/40"
        onClick={onToggle}
      >
        <td className="px-4 py-2">
          <span className="inline-flex items-center gap-1.5">
            <ChevronRight
              className={cn('h-3.5 w-3.5 text-muted-foreground transition-transform', open && 'rotate-90')}
            />
            {client.clientName}
            <span className="text-xs text-muted-foreground">({client.orders.length})</span>
          </span>
        </td>
        <td className="px-4 py-2 text-right tabular-nums">{formatRub(client.buckets['0-30'])}</td>
        <td className="px-4 py-2 text-right tabular-nums">{formatRub(client.buckets['30-60'])}</td>
        <td className="px-4 py-2 text-right tabular-nums text-destructive">
          {formatRub(client.buckets['60+'])}
        </td>
        <td className="px-4 py-2 text-right font-medium tabular-nums">{formatRub(client.due)}</td>
      </tr>
      {open &&
        client.orders.map((o) => (
          <tr key={o.orderId} className="border-b border-border bg-secondary/20 text-xs last:border-0">
            <td className="py-1.5 pl-10 pr-4 text-muted-foreground">
              № {o.number} · {fmtDate(o.createdAt)} · {o.ageDays} дн.
            </td>
            <td colSpan={3} className="px-4 py-1.5 text-right tabular-nums text-muted-foreground">
              оплачено {formatRub(o.paid)} из {formatRub(o.total)}
            </td>
            <td className={cn('px-4 py-1.5 text-right tabular-nums', BUCKET_TONE[o.bucket])}>
              {formatRub(o.due)}
            </td>
          </tr>
        ))}
    </>
  );
}
