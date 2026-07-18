'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { D, add, toMoneyString, formatRub } from '@construct/shared';
import { ShoppingCart, RotateCcw, Plus, X, Receipt } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/Sheet';
import { toast } from '@/components/ui/Toaster';
import { PurchaseSheet } from '@/components/purchases/PurchaseSheet';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { usePurchases, useVoidPurchase } from '@/hooks/usePurchases';
import { useCreateFromUrl } from '@/hooks/useCreateFromUrl';
import type { Purchase } from '@/lib/types';
import { formatDate } from '@/lib/dates';

function purchaseTotal(p: Purchase): string {
  if (p.transaction?.amount) return p.transaction.amount;
  return p.lines.reduce((acc, l) => acc + Number(l.lineTotal), 0).toFixed(2);
}

export default function PurchasesPage() {
  const router = useRouter();
  const ws = useCurrentWorkspace();
  const wsId = ws.currentId;
  const purchases = usePurchases(wsId);
  const voidPurchase = useVoidPurchase(wsId ?? '');
  const [confirmVoid, setConfirmVoid] = useState<Purchase | null>(null);
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState<Purchase | null>(null);
  // Глобальное «+ Создать» → ?new=1 открывает форму закупки.
  useCreateFromUrl(() => setCreating(true));

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
          {formatDate(p.transaction?.date ?? p.createdAt)}
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
        <Button
          variant="ghost"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            setConfirmVoid(p);
          }}
          title="Отменить закупку"
        >
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
        actions={
          <div className="flex items-center gap-2">
            {/* Ф6: мастер обработки чека (WB/ДНС/Онлайн Трейд/ручной → склад/заказ). */}
            <Button variant="secondary" onClick={() => router.push('/purchases/wb-receipt')}>
              <Receipt className="h-4 w-4" />
              Загрузить чек
            </Button>
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" />
              Закупка
            </Button>
          </div>
        }
      />

      <div className="bg-card border-t border-border">
        <DataTable
          data={purchases.data ?? []}
          columns={columns}
          rowKey={(p) => p.id}
          footer={{
            supplier: 'Итого по видимым',
            // Σ purchaseTotal по строкам — Decimal, без Number (решение №28).
            total: formatRub(
              toMoneyString(
                (purchases.data ?? []).reduce((acc, p) => add(acc, purchaseTotal(p)), D(0)),
              ),
            ),
          }}
          onRowClick={(p) => setDetail(p)}
          loading={purchases.isLoading}
          error={purchases.error}
          onRetry={() => void purchases.refetch()}
          empty={
            <EmptyState
              icon={ShoppingCart}
              title="Закупок пока нет"
              hint="Проведите первую закупку — товар придёт на склад, деньги спишутся со счёта."
              action={
                <Button onClick={() => setCreating(true)}>
                  <Plus className="h-4 w-4" /> Закупка
                </Button>
              }
            />
          }
          mobileCards={(p) => (
            <div className="space-y-1" onClick={() => setDetail(p)}>
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">
                  {p.supplier?.name ?? 'Без поставщика'}
                </span>
                <span className="tabular-nums">{formatRub(purchaseTotal(p))}</span>
              </div>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span className="tabular-nums">
                  {formatDate(p.transaction?.date ?? p.createdAt)} · {p.lines.length} поз.
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmVoid(p);
                  }}
                >
                  <RotateCcw className="h-3.5 w-3.5" /> Отменить
                </Button>
              </div>
            </div>
          )}
        />
      </div>

      {/* Состав закупки — данные уже в строке списка, запрос не нужен. */}
      <Sheet open={detail !== null} onOpenChange={(o) => !o && setDetail(null)}>
        <SheetContent side="right" hideClose>
          <SheetHeader className="flex-row items-center justify-between gap-2 space-y-0">
            <SheetTitle>
              Закупка от{' '}
              {detail ? formatDate(detail.transaction?.date ?? detail.createdAt) : ''}
            </SheetTitle>
            <Button variant="ghost" size="icon" onClick={() => setDetail(null)} aria-label="Закрыть">
              <X className="h-4 w-4" />
            </Button>
          </SheetHeader>
          <SheetBody className="space-y-4">
            {detail && (
              <>
                <div className="space-y-1 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Поставщик</span>
                    <span>{detail.supplier?.name ?? '—'}</span>
                  </div>
                  {detail.note && (
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">Комментарий</span>
                      <span className="text-right">{detail.note}</span>
                    </div>
                  )}
                </div>
                <div className="space-y-1.5">
                  <div className="text-sm font-medium">Состав</div>
                  <div className="divide-y divide-border rounded-md border border-border">
                    {detail.lines.map((l) => (
                      <div key={l.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                        <span className="min-w-0 truncate">
                          {l.warehouseItem?.name ?? 'Позиция склада'}
                        </span>
                        <span className="whitespace-nowrap text-muted-foreground tabular-nums">
                          {Number(l.qty)} × {formatRub(l.unitPrice)} ={' '}
                          <span className="font-medium text-foreground">{formatRub(l.lineTotal)}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="rounded-md border border-border bg-secondary/40 p-3 text-sm">
                  <div className="flex justify-between font-semibold">
                    <span>Сумма закупки</span>
                    <span className="tabular-nums">{formatRub(purchaseTotal(detail))}</span>
                  </div>
                </div>
              </>
            )}
          </SheetBody>
          <SheetFooter>
            <Button
              type="button"
              variant="destructive"
              className="sm:mr-auto"
              onClick={() => {
                if (detail) setConfirmVoid(detail);
                setDetail(null);
              }}
            >
              <RotateCcw className="h-3.5 w-3.5" /> Отменить закупку
            </Button>
            <Button type="button" variant="secondary" onClick={() => setDetail(null)}>
              Закрыть
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <PurchaseSheet wsId={wsId} open={creating} onClose={() => setCreating(false)} />

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
