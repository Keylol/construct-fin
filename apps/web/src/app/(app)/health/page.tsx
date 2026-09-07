'use client';

import { useRouter } from 'next/navigation';
import { ArrowRight, Check } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatusDot } from '@/components/ui/StatusDot';
import { DataTable, type Column } from '@/components/ui/DataTable';
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
  const router = useRouter();
  const { current } = useCurrentWorkspace();
  const wsId = current?.id ?? null;
  const { checks, failing, isLoading } = useHealthChecks(wsId);

  if (!current) return null;

  const columns: Column<HealthCheck>[] = [
    {
      key: 'check',
      header: 'Проверка',
      cell: (c) => {
        const ok = c.tone === 'ok';
        return (
          <div className="flex items-center gap-2">
            {ok ? (
              <Check className="h-3.5 w-3.5 shrink-0 text-success" aria-label="Пройдена" />
            ) : (
              <StatusDot tone={c.tone === 'destructive' ? 'destructive' : 'warning'} label="" />
            )}
            <span className={cn('font-medium', ok && 'text-muted-foreground')}>{c.title}</span>
          </div>
        );
      },
      className: 'w-[280px]',
    },
    {
      key: 'detail',
      header: 'Что именно',
      className: 'w-full max-w-0',
      cell: (c) => <span className="block truncate text-muted-foreground" title={c.detail}>{c.detail}</span>,
    },
    {
      key: 'go',
      header: '',
      align: 'right',
      hoverOnly: true,
      cell: () => <ArrowRight className="h-4 w-4 text-muted-foreground" aria-hidden />,
      className: 'w-[48px]',
    },
  ];

  return (
    <>
      <PageHeader
        title="Здоровье"
        description={
          failing.length === 0 && !isLoading
            ? 'Все проверки пройдены — учёт сведён.'
            : `Что в учёте не доделано. Каждая строка ведёт туда, где это исправляют${
                checks.length ? ` — требует внимания: ${failing.length} из ${checks.length}` : ''
              }.`
        }
      />

      <div className="bg-card">
        <DataTable
          data={checks}
          columns={columns}
          rowKey={(c) => c.key}
          loading={isLoading}
          onRowClick={(c) => router.push(c.href as Parameters<typeof router.push>[0])}
          mobileCards={(c) => (
            <div className="flex items-start gap-3">
              {c.tone === 'ok' ? (
                <Check className="mt-1 h-3.5 w-3.5 shrink-0 text-success" />
              ) : (
                <StatusDot tone={c.tone === 'destructive' ? 'destructive' : 'warning'} label="" className="mt-1" />
              )}
              <div className="min-w-0 flex-1">
                <div className="font-medium">{c.title}</div>
                <div className="text-xs text-muted-foreground">{c.detail}</div>
              </div>
              <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
            </div>
          )}
        />
      </div>
    </>
  );
}
