'use client';

import { Suspense, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { D, add, toMoneyString } from '@construct/shared';
import { ShoppingCart, RotateCcw, Plus, X, Receipt } from '@/components/ui/icons';
import { Money } from '@/components/ui/Money';
import { KpiCard } from '@/components/ui/KpiCard';
import { KpiRow } from '@/components/ui/KpiRow';
import { FilterBar } from '@/components/ui/FilterBar';
import { FilterField } from '@/components/ui/FilterField';
import { SearchField } from '@/components/ui/SearchField';
import { PeriodSelect } from '@/components/ui/PeriodSelect';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  ModalClose,
} from '@/components/ui/Modal';
import { toast } from '@/components/ui/Toaster';
import { PurchaseModal } from '@/components/purchases/PurchaseModal';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useListHotkeys } from '@/hooks/useListHotkeys';
import { usePurchases, useVoidPurchase } from '@/hooks/usePurchases';
import { useCreateFromUrl } from '@/hooks/useCreateFromUrl';
import { useUrlDialog } from '@/hooks/useUrlDialog';
import type { Purchase } from '@/lib/types';
import { formatDate } from '@/lib/dates';
import { useUrlFilters } from '@/hooks/useUrlFilters';
import { flatCodec } from '@/lib/url-codec';
import { rangeForAny, type AnyPeriod } from '@/lib/periods';

function purchaseTotal(p: Purchase): string {
  if (p.transaction?.amount) return p.transaction.amount;
  return toMoneyString(p.lines.reduce((acc, l) => add(acc, D(l.lineTotal)), D(0)));
}

const DEFAULTS = { q: '', period: 'all' };
const FILTERS = flatCodec(DEFAULTS);

// useSearchParams требует Suspense-границу на уровне page (Next 14 App Router).
export default function PurchasesPage() {
  return (
    <Suspense>
      <PurchasesView />
    </Suspense>
  );
}

function PurchasesView() {
  const router = useRouter();
  const ws = useCurrentWorkspace();
  const wsId = ws.currentId;
  const purchases = usePurchases(wsId);
  const voidPurchase = useVoidPurchase(wsId ?? '');
  const [confirmVoid, setConfirmVoid] = useState<Purchase | null>(null);
  const [creating, setCreating] = useState(false);
  // Список приходит целиком — поиск и период считаем на клиенте, но держим их в
  // адресе, как у остальных списков.
  const [filters, setFilters] = useUrlFilters(FILTERS);
  const range = useMemo(() => rangeForAny(filters.period as AnyPeriod), [filters.period]);
  const rows = useMemo(() => {
    const q = filters.q.trim().toLowerCase();
    return (purchases.data ?? []).filter((p) => {
      const date = p.transaction?.date ?? p.createdAt;
      if (range.from && date < range.from) return false;
      if (range.to && date > range.to) return false;
      if (!q) return true;
      const hay = `${p.supplier?.name ?? ''} ${p.note ?? ''} ${p.lines
        .map((l) => l.warehouseItem?.name ?? '')
        .join(' ')}`.toLowerCase();
      return hay.includes(q);
    });
  }, [purchases.data, filters.q, range]);
  const total = useMemo(
    () => toMoneyString(rows.reduce((acc, p) => add(acc, purchaseTotal(p)), D(0))),
    [rows],
  );
  const searchRef = useRef<HTMLInputElement>(null);
  useListHotkeys({ searchRef, onNew: () => setCreating(true) });
  // Открытая закупка — в адресе (?purchase=<id>), как и заказ. Сам объект
  // берём из уже загруженного списка: отдельного запроса на одну закупку
  // во фронте нет, а список приходит целиком.
  const purchaseUrl = useUrlDialog('purchase');
  const detail = (purchases.data ?? []).find((p) => p.id === purchaseUrl.value) ?? null;
  // Глобальное «+ Создать» → ?new=1 открывает форму закупки.
  useCreateFromUrl(() => setCreating(true));

  if (!wsId) return null;

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
      cell: (p) => <Money value={purchaseTotal(p)} />,
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

      <div className="px-6 py-4">
        <KpiRow loading={purchases.isLoading} count={2}>
          <KpiCard label="Сумма закупок за период" value={<Money value={total} />} />
          <KpiCard label="Закупок" value={String(rows.length)} />
        </KpiRow>
      </div>

      <FilterBar>
        <div className="min-w-[220px] max-w-md flex-1">
          <FilterField label="Поиск">
            <SearchField
              ref={searchRef}
              value={filters.q}
              onChange={(e) => setFilters({ ...filters, q: e.target.value })}
              placeholder="Поставщик, позиция или комментарий"
            />
          </FilterField>
        </div>
        <PeriodSelect
          value={filters.period as AnyPeriod}
          onChange={(period) => setFilters({ ...filters, period })}
        />
        <Button variant="ghost" size="sm" onClick={() => setFilters(DEFAULTS)} className="self-end">
          <RotateCcw className="h-3.5 w-3.5" />
          Сброс
        </Button>
      </FilterBar>

      <div className="bg-card">
        <DataTable
          data={rows}
          columns={columns}
          rowKey={(p) => p.id}
          footer={{
            supplier: 'Итого по видимым',
            // Σ purchaseTotal по строкам — Decimal, без Number (решение №28).
            total: <Money value={total} />,
          }}
          onRowClick={(p) => purchaseUrl.open(p.id)}
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
            <div className="space-y-1" onClick={() => purchaseUrl.open(p.id)}>
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">
                  {p.supplier?.name ?? 'Без поставщика'}
                </span>
                <Money value={purchaseTotal(p)} />
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
      <Modal open={detail !== null} onOpenChange={(o) => !o && purchaseUrl.close()}>
        <ModalContent size="lg" hideClose>
          <ModalHeader className="flex-row items-center justify-between gap-2 space-y-0">
            <ModalTitle>
              Закупка от{' '}
              {detail ? formatDate(detail.transaction?.date ?? detail.createdAt) : ''}
            </ModalTitle>
            <ModalClose asChild>
              <Button variant="ghost" size="icon" aria-label="Закрыть">
                <X className="h-4 w-4" />
              </Button>
            </ModalClose>
          </ModalHeader>
          <ModalBody className="space-y-4">
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
                          {Number(l.qty)} × <Money value={l.unitPrice} tone="plain" /> ={' '}
                          <span className="font-medium text-foreground"><Money value={l.lineTotal} /></span>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="rounded-md border border-border bg-secondary/40 p-3 text-sm">
                  <div className="flex justify-between font-semibold">
                    <span>Сумма закупки</span>
                    <Money value={purchaseTotal(detail)} />
                  </div>
                </div>
              </>
            )}
          </ModalBody>
          <ModalFooter>
            <Button
              type="button"
              variant="destructive"
              className="sm:mr-auto"
              onClick={() => {
                if (detail) setConfirmVoid(detail);
                purchaseUrl.close();
              }}
            >
              <RotateCcw className="h-3.5 w-3.5" /> Отменить закупку
            </Button>
            <ModalClose asChild>
              <Button type="button" variant="secondary">
                Закрыть
              </Button>
            </ModalClose>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <PurchaseModal wsId={wsId} open={creating} onClose={() => setCreating(false)} />

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
