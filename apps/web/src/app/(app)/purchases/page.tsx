'use client';

import { useState } from 'react';
import { formatRub } from '@construct/shared';
import { ShoppingCart, RotateCcw } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { toast } from '@/components/ui/Toaster';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { usePurchases, useVoidPurchase } from '@/hooks/usePurchases';
import type { Purchase } from '@/lib/types';

const DT_FMT = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

function purchaseTotal(p: Purchase): string {
  if (p.transaction?.amount) return p.transaction.amount;
  return p.lines.reduce((acc, l) => acc + Number(l.lineTotal), 0).toFixed(2);
}

export default function PurchasesPage() {
  const ws = useCurrentWorkspace();
  const wsId = ws.currentId;
  const purchases = usePurchases(wsId);
  const voidPurchase = useVoidPurchase(wsId ?? '');
  const [confirmVoid, setConfirmVoid] = useState<Purchase | null>(null);

  if (!wsId) {
    return (
      <>
        <PageHeader title="Закупки" />
        <div className="p-6">
          <EmptyState
            icon={ShoppingCart}
            title="Нет активного пространства"
            hint="Выберите или создайте пространство."
          />
        </div>
      </>
    );
  }

  const columns: Column<Purchase>[] = [
    {
      key: 'date',
      header: 'Дата',
      cell: (p) => (
        <span className="whitespace-nowrap text-muted-foreground tabular-nums">
          {DT_FMT.format(new Date(p.transaction?.date ?? p.createdAt))}
        </span>
      ),
      className: 'w-[120px]',
    },
    {
      key: 'supplier',
      header: 'Поставщик',
      cell: (p) => p.supplier?.name ?? <span className="text-muted-foreground">—</span>,
    },
    {
      key: 'lines',
      header: 'Позиций',
      align: 'right',
      cell: (p) => p.lines.length,
      className: 'w-[90px]',
    },
    {
      key: 'total',
      header: 'Сумма',
      align: 'right',
      cell: (p) => <span className="tabular-nums">{formatRub(purchaseTotal(p))}</span>,
      className: 'w-[130px]',
    },
    {
      key: 'note',
      header: 'Комментарий',
      cell: (p) => (
        <span className="block max-w-[240px] truncate text-muted-foreground" title={p.note ?? ''}>
          {p.note ?? ''}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (p) => (
        <Button variant="ghost" size="sm" onClick={() => setConfirmVoid(p)} title="Отменить закупку">
          <RotateCcw className="h-3.5 w-3.5" /> Отменить
        </Button>
      ),
      className: 'w-[130px]',
    },
  ];

  return (
    <>
      <PageHeader
        title="Закупки"
        breadcrumbs={[{ label: 'Учёт' }, { label: 'Закупки' }]}
      />

      <div className="bg-card border-t border-border">
        <DataTable
          data={purchases.data ?? []}
          columns={columns}
          rowKey={(p) => p.id}
          loading={purchases.isLoading}
          empty={
            <EmptyState
              icon={ShoppingCart}
              title="Закупок пока нет"
              hint="Закупки создаются со страницы склада (приход товара на склад)."
            />
          }
          mobileCards={(p) => (
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">
                  {p.supplier?.name ?? 'Без поставщика'}
                </span>
                <span className="tabular-nums">{formatRub(purchaseTotal(p))}</span>
              </div>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span className="tabular-nums">
                  {DT_FMT.format(new Date(p.transaction?.date ?? p.createdAt))} · {p.lines.length} поз.
                </span>
                <Button variant="ghost" size="sm" onClick={() => setConfirmVoid(p)}>
                  <RotateCcw className="h-3.5 w-3.5" /> Отменить
                </Button>
              </div>
            </div>
          )}
        />
      </div>

      <ConfirmDialog
        open={confirmVoid !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmVoid(null);
        }}
        title="Отменить закупку?"
        description="Приход товара на склад и списание денег будут отменены. Это возможно только если товар из партий закупки ещё не продан и не списан — иначе оформите возврат поставщику."
        confirmText="Отменить закупку"
        onConfirm={async () => {
          if (!confirmVoid) return;
          try {
            await voidPurchase.mutateAsync(confirmVoid.id);
            toast.success('Закупка отменена');
          } catch (e) {
            // Ожидаемый 400: товар из партий уже продан/списан — объясняем.
            toast.error(e instanceof Error ? e.message : 'Не удалось отменить закупку');
          }
          setConfirmVoid(null);
        }}
        loading={voidPurchase.isPending}
      />
    </>
  );
}
