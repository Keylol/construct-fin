'use client';

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { OrderDetailModal } from '@/components/orders/OrderDetailModal';
import { OrderFormModal } from '@/components/orders/OrderFormModal';
import { OrderGroupTile, OrderTile } from '@/components/orders/OrderTile';
import { PAY_LABEL, PAY_TONE, STATUS_LABEL, STATUS_TONE, canCloseOrder } from '@/components/orders/order-shared';
import { Button } from '@/components/ui/Button';
import { LoadMore } from '@/components/ui/LoadMore';
import { type Column, DataTable } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { FilterBar } from '@/components/ui/FilterBar';
import { Input } from '@/components/ui/Input';
import { Money } from '@/components/ui/Money';
import { PageHeader } from '@/components/ui/PageHeader';
import { Select } from '@/components/ui/Select';
import { StatusDot } from '@/components/ui/StatusDot';
import { TileGrid, ViewToggle, useTileView } from '@/components/ui/Tile';
import { ClipboardList, Plus, X } from '@/components/ui/icons';
import { useCreateFromUrl } from '@/hooks/useCreateFromUrl';
import { useListHotkeys } from '@/hooks/useListHotkeys';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useOrders } from '@/hooks/useOrders';
import { useUrlDialog } from '@/hooks/useUrlDialog';
import { formatDate } from '@/lib/dates';
import type { Order, OrderStatus } from '@/lib/types';
import { D, add, formatRub, toMoneyString } from '@construct/shared';

// useSearchParams требует Suspense-границу на уровне page (Next 14 App Router).
export default function OrdersPage() {
  return (
    <Suspense>
      <OrdersView />
    </Suspense>
  );
}

function OrdersView() {
  const { current } = useCurrentWorkspace();
  const wsId = current?.id ?? null;
  const [statusFilter, setStatusFilter] = useState<OrderStatus | ''>('');
  // Фильтр по клиенту — приходит переходом с его плитки (?client=<id>).
  const [clientFilter, setClientFilter] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  // IJ9 drill-down «Выручка» из ОПиУ: период по дате ЗАКРЫТИЯ заказа
  // (?closedFrom&closedTo&status=DONE). Читаем window.location в эффекте
  // (как useCreateFromUrl) — без Suspense и hydration-рассинхрона.
  const [closedRange, setClosedRange] = useState<{ from?: string; to?: string } | null>(null);
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const from = sp.get('closedFrom') || undefined;
    const to = sp.get('closedTo') || undefined;
    if (from || to) {
      setClosedRange({ from, to });
      const st = sp.get('status');
      if (st === 'OPEN' || st === 'DONE' || st === 'CANCELLED') setStatusFilter(st);
    }
  }, []);
  // Снятие чипа чистит и URL — иначе refresh вернул бы фильтр из адреса.
  const clearClosedRange = () => {
    setClosedRange(null);
    const sp = new URLSearchParams(window.location.search);
    sp.delete('closedFrom');
    sp.delete('closedTo');
    const qs = sp.toString();
    window.history.replaceState(
      null,
      '',
      qs ? `${window.location.pathname}?${qs}` : window.location.pathname,
    );
  };
  // В инпуте — сырой search, в запрос уходит значение после паузы в наборе.
  const debouncedSearch = useDebouncedValue(search);
  const orders = useOrders(wsId, {
    clientId: clientFilter || undefined,
    status: statusFilter || undefined,
    search: debouncedSearch || undefined,
    closedFrom: closedRange?.from,
    closedTo: closedRange?.to,
  });
  const orderRows = useMemo<Order[]>(
    () => orders.data?.pages.flatMap((p) => p.items) ?? [],
    [orders.data],
  );
  // Σ-итог списка (решение №28): по загруженным страницам, только Decimal.
  const listTotals = useMemo(() => {
    let paid = D(0);
    let total = D(0);
    for (const o of orderRows) {
      paid = add(paid, D(o.paidAmount));
      total = add(total, D(o.totalAmount));
    }
    return { paid: toMoneyString(paid), total: toMoneyString(total) };
  }, [orderRows]);

  /**
   * Плитки группируются по телефону: заказы одного клиента складываются в
   * «папку» со счётчиком, одиночные показываются как есть. Порядок исходного
   * списка сохраняется — по дате создания, как в списке.
   */
  const tileGroups = useMemo(() => {
    const groups: { key: string; orders: Order[] }[] = [];
    const byPhone = new Map<string, { key: string; orders: Order[] }>();
    for (const o of orderRows) {
      if (!o.phone) {
        groups.push({ key: o.id, orders: [o] });
        continue;
      }
      const existing = byPhone.get(o.phone);
      if (existing) {
        existing.orders.push(o);
        continue;
      }
      const g = { key: o.phone, orders: [o] };
      byPhone.set(o.phone, g);
      groups.push(g);
    }
    return groups;
  }, [orderRows]);

  const tileLabels = {
    statusLabel: STATUS_LABEL,
    statusTone: STATUS_TONE,
    payLabel: PAY_LABEL,
    payTone: PAY_TONE,
  };

  const [creating, setCreating] = useState(false);
  // Открытый заказ — в адресе (?order=<id>): карточка переживает обновление
  // страницы, «назад» закрывает её, ссылку можно сохранить.
  const orderUrl = useUrlDialog('order');
  const openId = orderUrl.value;
  // Заказ, открытый кликом по «можно закрыть»: карточка сразу показывает диалог
  // закрытия, но дату и подтверждение по-прежнему спрашивает.
  const [closingId, setClosingId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Order | null>(null);
  // Список — рабочий режим (поиск по сумме, сверка, итоги), плитки — обзорный.
  const [view, changeView] = useTileView('orders:view');
  // Раскрытая «папка» телефона: у повторного клиента несколько заказов.
  const [openPhone, setOpenPhone] = useState<string | null>(null);
  // Глобальное «+ Создать» → ?new=1 открывает форму заказа.
  useCreateFromUrl(() => setCreating(true));

  // «/» — в поиск, «n» — новый заказ: заведение архива идёт пачкой.
  const searchRef = useRef<HTMLInputElement>(null);
  useListHotkeys({ searchRef, onNew: () => setCreating(true) });

  /**
   * Переход с плитки клиента: ?client=<id> оставляет на экране только его
   * заказы. Экран клиента между кликом и делом не нужен — владелец идёт к
   * заказу, а не к справочнику. Параметр разовый: после применения убираем его
   * из адреса, чтобы «назад» не возвращал фильтр. Сам заказ открывается уже не
   * так, а постоянным ?order=<id> (useUrlDialog выше).
   */
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sp = new URLSearchParams(window.location.search);
    const client = sp.get('client');
    if (!client) return;
    setClientFilter(client);
    sp.delete('client');
    const qs = sp.toString();
    window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : ''));
    // Разовый триггер на маунте — как в useCreateFromUrl.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!current) return null;

  const columns: Column<Order>[] = [
    {
      key: 'number',
      header: 'Номер',
      cell: (o) => (
        <div className="min-w-0">
          <div className="font-medium">{o.number}</div>
          {o.title && (
            <div className="truncate text-xs text-muted-foreground">{o.title}</div>
          )}
        </div>
      ),
      className: 'w-[160px]',
    },
    {
      key: 'client',
      header: 'Клиент',
      cell: (o) => (
        <span className="text-muted-foreground">{o.client?.name ?? '—'}</span>
      ),
    },
    {
      key: 'status',
      header: 'Статус',
      cell: (o) => (
        <StatusDot tone={STATUS_TONE[o.status]} label={STATUS_LABEL[o.status]} />
      ),
      className: 'w-[120px]',
    },
    {
      key: 'payment',
      header: 'Оплата',
      cell: (o) => (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <StatusDot tone={PAY_TONE[o.paymentStatus]} label={PAY_LABEL[o.paymentStatus]} />
          {/* F2: платёж по графику пропущен — видно без открытия карточки. */}
          {o.scheduleSummary && o.scheduleSummary.overdueAmount !== '0.00' && (
            <StatusDot tone="destructive" label="Просрочен" />
          )}
          {canCloseOrder(o) && (
            <button
              type="button"
              title="Оплачен полностью — закрыть заказ"
              onClick={(e) => {
                e.stopPropagation();
                setClosingId(o.id);
                orderUrl.open(o.id);
              }}
              className="underline-offset-2 hover:underline"
            >
              <StatusDot tone="primary" label="можно закрыть" />
            </button>
          )}
        </div>
      ),
      className: 'w-[150px]',
    },
    {
      key: 'paid',
      header: 'Оплачено',
      align: 'right',
      cell: (o) => (
        <Money value={o.paidAmount} tone="plain" className="text-muted-foreground" />
      ),
      className: 'w-[140px]',
    },
    {
      key: 'total',
      header: 'Сумма',
      align: 'right',
      cell: (o) => <Money value={o.totalAmount} className="font-semibold" />,
      className: 'w-[140px]',
    },
  ];

  return (
    <>
      <PageHeader
        title="Заказы"
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" />
            Новый заказ
          </Button>
        }
      />

      <FilterBar>
        <label className="flex flex-col text-xs text-muted-foreground">
          <span className="pb-1">Поиск</span>
          <Input
            ref={searchRef}
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Номер или название"
            className="h-9 w-[220px]"
          />
        </label>
        <label className="flex flex-col text-xs text-muted-foreground">
          <span className="pb-1">Статус</span>
          <Select
            value={statusFilter}
            onChange={(e) => {
              const st = e.target.value as OrderStatus | '';
              setStatusFilter(st);
              // Период закрытия совместим только с DONE (у OPEN/CANCELLED нет
              // closedAt — фильтр дал бы пустой список без объяснения).
              if (closedRange && (st === 'OPEN' || st === 'CANCELLED')) clearClosedRange();
            }}
            className="h-9 w-[150px]"
          >
            <option value="">Все</option>
            <option value="OPEN">В работе</option>
            <option value="DONE">Закрыт</option>
            <option value="CANCELLED">Отменён</option>
          </Select>
        </label>
        {/* IJ9: чип периода закрытия — приходит только drill-down'ом из ОПиУ */}
        {closedRange && (
          <label className="flex flex-col text-xs text-muted-foreground">
            <span className="pb-1">Закрыты в периоде</span>
            <button
              type="button"
              onClick={clearClosedRange}
              title="Снять фильтр периода закрытия"
              className="flex h-9 items-center gap-1.5 rounded-sm border border-input bg-secondary px-2.5 text-sm text-foreground transition-colors hover:bg-secondary/70"
            >
              {closedRange.from ? formatDate(closedRange.from) : '…'}
              {' — '}
              {closedRange.to ? formatDate(closedRange.to) : '…'}
              <X className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
            </button>
          </label>
        )}
        <ViewToggle view={view} onChange={changeView} />
      </FilterBar>

      {view === 'tiles' ? (
        <div className="space-y-4">
          {orders.isLoading ? (
            <p className="p-6 text-sm text-muted-foreground">Загрузка…</p>
          ) : orderRows.length === 0 ? (
            <EmptyState
              icon={ClipboardList}
              title="Пока нет заказов"
              hint="Создайте первый заказ: привяжите клиента, добавьте позиции и принимайте оплату."
              action={
                <Button onClick={() => setCreating(true)}>
                  <Plus className="h-4 w-4" /> Новый заказ
                </Button>
              }
            />
          ) : (
            <>
              <TileGrid>
                {tileGroups.map((g) =>
                  g.orders.length === 1 ? (
                    <OrderTile
                      key={g.key}
                      order={g.orders[0]!}
                      labels={tileLabels}
                      closable={canCloseOrder(g.orders[0]!)}
                      onRequestClose={() => {
                        setClosingId(g.orders[0]!.id);
                        orderUrl.open(g.orders[0]!.id);
                      }}
                      onClick={() => orderUrl.open(g.orders[0]!.id)}
                    />
                  ) : (
                    <div key={g.key} className="flex flex-col gap-2">
                      <OrderGroupTile
                        phone={g.key}
                        orders={g.orders}
                        expanded={openPhone === g.key}
                        onToggle={() => setOpenPhone(openPhone === g.key ? null : g.key)}
                      />
                      {openPhone === g.key &&
                        g.orders.map((o) => (
                          <div key={o.id} className="pl-3">
                            <OrderTile
                              order={o}
                              labels={tileLabels}
                              closable={canCloseOrder(o)}
                              onRequestClose={() => {
                                setClosingId(o.id);
                                orderUrl.open(o.id);
                              }}
                              onClick={() => orderUrl.open(o.id)}
                            />
                          </div>
                        ))}
                    </div>
                  ),
                )}
              </TileGrid>
              <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-card px-4 py-3 text-sm">
                <span className="text-muted-foreground">Итого по видимым</span>
                <span className="tabular-nums">
                  оплачено {formatRub(listTotals.paid)} из {formatRub(listTotals.total)}
                </span>
              </div>
            </>
          )}
          <LoadMore hasMore={orders.hasNextPage} loading={orders.isFetchingNextPage} onClick={() => void orders.fetchNextPage()} />
        </div>
      ) : (
      <div className="bg-card">
        <DataTable
          data={orderRows}
          columns={columns}
          rowKey={(o) => o.id}
          onRowClick={(o) => orderUrl.open(o.id)}
          loading={orders.isLoading}
          error={orders.error}
          onRetry={() => orders.refetch()}
          empty={
            <EmptyState
              icon={ClipboardList}
              title="Пока нет заказов"
              hint="Создайте первый заказ: привяжите клиента, добавьте позиции и принимайте оплату."
              action={
                <Button onClick={() => setCreating(true)}>
                  <Plus className="h-4 w-4" /> Новый заказ
                </Button>
              }
            />
          }
          footer={{
            number: 'Итого по видимым',
            paid: formatRub(listTotals.paid),
            total: formatRub(listTotals.total),
          }}
          mobileCards={(o) => (
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{o.number}</span>
                <Money value={o.totalAmount} className="font-semibold" />
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                {o.client?.name ?? 'Без клиента'}
                <StatusDot
                  tone={STATUS_TONE[o.status]}
                  label={STATUS_LABEL[o.status]}
                  className="text-xs"
                />
                <StatusDot
                  tone={PAY_TONE[o.paymentStatus]}
                  label={PAY_LABEL[o.paymentStatus]}
                  className="text-xs"
                />
                {canCloseOrder(o) && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setClosingId(o.id);
                      orderUrl.open(o.id);
                    }}
                    className="underline-offset-2 hover:underline"
                  >
                    <StatusDot tone="primary" label="можно закрыть" className="text-xs" />
                  </button>
                )}
              </div>
            </div>
          )}
        />
        <LoadMore hasMore={orders.hasNextPage} loading={orders.isFetchingNextPage} onClick={() => void orders.fetchNextPage()} />
      </div>
      )}

      <OrderFormModal
        wsId={current.id}
        open={creating || !!editing}
        editing={editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        onCreated={(id, paid) => {
          // Заказ без оплаты — половина работы: деньги за архивные заказы уже
          // лежат во «Входящих», и карточка сразу показывает, как их привязать.
          if (!paid) orderUrl.open(id);
        }}
      />
      <OrderDetailModal
        wsId={current.id}
        orderId={openId}
        autoClose={!!openId && openId === closingId}
        onClose={() => {
          orderUrl.close();
          setClosingId(null);
        }}
        onEdit={(o) => {
          orderUrl.close();
          setClosingId(null);
          setEditing(o);
        }}
      />
    </>
  );
}

// ─────────────────────────── Create / edit order ───────────────────────────
