'use client';

import { useEffect, useMemo, useState } from 'react';
import { Plus, ClipboardList, X, Trash2, Paperclip } from '@/components/ui/icons';
import { formatRub, parseAmountInput, D, add, sub, mul, toMoneyString } from '@construct/shared';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useCounterparties } from '@/hooks/useCounterparties';
import { useAccounts } from '@/hooks/useAccounts';
import { useWarehouse } from '@/hooks/useWarehouse';
import {
  useOrders,
  useOrder,
  useCreateOrder,
  useUpdateOrder,
  useAddOrderPayment,
  useFinalizeOrder,
  useCancelOrder,
  useReopenOrder,
  useUploadOrderAttachment,
  useDeleteOrderAttachment,
  type OrderItemInput,
} from '@/hooks/useOrders';
import type { Order, OrderStatus, OrderPaymentState } from '@/lib/types';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Select } from '@/components/ui/Select';
import { Badge, type BadgeProps } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { FormField } from '@/components/ui/FormField';
import { FilterBar } from '@/components/ui/FilterBar';
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
import { cn } from '@/lib/cn';

const STATUS_LABEL: Record<OrderStatus, string> = {
  OPEN: 'В работе',
  DONE: 'Выполнен',
  CANCELLED: 'Отменён',
};
const STATUS_VARIANT: Record<OrderStatus, BadgeProps['variant']> = {
  OPEN: 'default',
  DONE: 'success',
  CANCELLED: 'destructive',
};
const PAY_LABEL: Record<OrderPaymentState, string> = {
  UNPAID: 'Не оплачен',
  PARTIAL: 'Частично',
  PAID: 'Оплачен',
  OVERPAID: 'Переплата',
  REFUNDED: 'Возврат',
};
const PAY_VARIANT: Record<OrderPaymentState, BadgeProps['variant']> = {
  UNPAID: 'muted',
  PARTIAL: 'outline',
  PAID: 'success',
  OVERPAID: 'outline',
  REFUNDED: 'destructive',
};

const DATE_FMT = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

export default function OrdersPage() {
  const { current } = useCurrentWorkspace();
  const wsId = current?.id ?? null;
  const [statusFilter, setStatusFilter] = useState<OrderStatus | ''>('');
  const [search, setSearch] = useState('');
  const orders = useOrders(wsId, {
    status: statusFilter || undefined,
    search: search || undefined,
  });
  const orderRows = useMemo<Order[]>(
    () => orders.data?.pages.flatMap((p) => p.items) ?? [],
    [orders.data],
  );

  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Order | null>(null);

  if (!current) {
    return (
      <>
        <PageHeader title="Заказы" />
        <div className="p-6">
          <EmptyState
            icon={ClipboardList}
            title="Нет активного пространства"
            hint="Выберите или создайте пространство."
          />
        </div>
      </>
    );
  }

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
        <Badge variant={STATUS_VARIANT[o.status]}>{STATUS_LABEL[o.status]}</Badge>
      ),
      className: 'w-[120px]',
    },
    {
      key: 'payment',
      header: 'Оплата',
      cell: (o) => (
        <Badge variant={PAY_VARIANT[o.paymentStatus]}>{PAY_LABEL[o.paymentStatus]}</Badge>
      ),
      className: 'w-[130px]',
    },
    {
      key: 'paid',
      header: 'Оплачено',
      align: 'right',
      cell: (o) => (
        <span className="text-muted-foreground tabular-nums">
          {formatRub(o.paidAmount)}
        </span>
      ),
      className: 'w-[140px]',
    },
    {
      key: 'total',
      header: 'Сумма',
      align: 'right',
      sortable: true,
      cell: (o) => <span className="font-semibold tabular-nums">{formatRub(o.totalAmount)}</span>,
      className: 'w-[140px]',
    },
  ];

  return (
    <>
      <PageHeader
        title="Заказы"
        breadcrumbs={[{ label: 'Учёт' }, { label: 'Заказы' }]}
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
            onChange={(e) => setStatusFilter(e.target.value as OrderStatus | '')}
            className="h-9 w-[150px]"
          >
            <option value="">Все</option>
            <option value="OPEN">В работе</option>
            <option value="DONE">Выполнен</option>
            <option value="CANCELLED">Отменён</option>
          </Select>
        </label>
      </FilterBar>

      <div className="bg-card">
        <DataTable
          data={orderRows}
          columns={columns}
          rowKey={(o) => o.id}
          onRowClick={(o) => setOpenId(o.id)}
          loading={orders.isLoading}
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
          mobileCards={(o) => (
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{o.number}</span>
                <span className="font-semibold tabular-nums">{formatRub(o.totalAmount)}</span>
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                {o.client?.name ?? 'Без клиента'}
                <Badge variant={STATUS_VARIANT[o.status]}>{STATUS_LABEL[o.status]}</Badge>
                <Badge variant={PAY_VARIANT[o.paymentStatus]}>{PAY_LABEL[o.paymentStatus]}</Badge>
              </div>
            </div>
          )}
        />
        {orders.hasNextPage && (
          <div className="flex justify-center border-t border-border py-4">
            <Button
              variant="secondary"
              onClick={() => orders.fetchNextPage()}
              disabled={orders.isFetchingNextPage}
            >
              {orders.isFetchingNextPage ? 'Загрузка…' : 'Загрузить ещё'}
            </Button>
          </div>
        )}
      </div>

      <OrderFormSheet
        wsId={current.id}
        open={creating || !!editing}
        editing={editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
      />
      <OrderDetailSheet
        wsId={current.id}
        orderId={openId}
        onClose={() => setOpenId(null)}
        onEdit={(o) => {
          setOpenId(null);
          setEditing(o);
        }}
      />
    </>
  );
}

// ─────────────────────────── Create / edit order ───────────────────────────

function OrderFormSheet({
  wsId,
  open,
  editing,
  onClose,
}: {
  wsId: string;
  open: boolean;
  editing: Order | null;
  onClose: () => void;
}) {
  const isEdit = !!editing;
  const clients = useCounterparties(wsId, undefined, false, 'CLIENT');
  const warehouse = useWarehouse(wsId);
  const create = useCreateOrder(wsId);
  const update = useUpdateOrder(wsId);

  const [clientId, setClientId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [discount, setDiscount] = useState('');
  const [items, setItems] = useState<OrderItemInput[]>([
    { name: '', qty: '1', unitPrice: '', unitCost: '' },
  ]);
  const [error, setError] = useState<string | null>(null);

  // Префилл при открытии на редактирование.
  useEffect(() => {
    if (!open) return;
    if (editing) {
      setClientId(editing.clientId ?? '');
      setTitle(editing.title ?? '');
      setDescription(editing.description ?? '');
      setDiscount(Number(editing.discountAmount) > 0 ? String(Number(editing.discountAmount)) : '');
      setItems(
        (editing.items ?? []).map((it) => ({
          warehouseItemId: it.warehouseItemId,
          name: it.name,
          qty: String(Number(it.qty)),
          unitPrice: String(Number(it.unitPrice)),
          unitCost: it.unitCost ? String(Number(it.unitCost)) : '',
        })),
      );
    } else {
      setClientId('');
      setTitle('');
      setDescription('');
      setDiscount('');
      setItems([{ name: '', qty: '1', unitPrice: '', unitCost: '' }]);
    }
    setError(null);
  }, [open, editing]);

  // Превью-итоги черновика через Decimal (не JS number, D4). Ввод свободный —
  // невалидное значение считаем нулём, «жёсткая» валидация остаётся на сабмите.
  const parseDraft = (s: string | null | undefined) => {
    try {
      return D((s ?? '').replace(/\s/g, '').replace(',', '.') || '0');
    } catch {
      return D(0);
    }
  };
  const subtotal = useMemo(
    () =>
      items.reduce(
        (acc, it) => add(acc, mul(parseDraft(it.qty), parseDraft(it.unitPrice))),
        D(0),
      ),
    [items],
  );
  // Себестоимость превью — как считает бэкенд (F1): ручная закупка, а для
  // складской строки без неё — оценка по текущей стоимости остатка (avgCost).
  const { costTotal, costIsEstimate } = useMemo(() => {
    let acc = D(0);
    let est = false;
    for (const it of items) {
      const whCost = it.warehouseItemId
        ? warehouse.data?.find((w) => w.id === it.warehouseItemId)?.avgCost
        : null;
      const manual = it.unitCost ? parseDraft(it.unitCost) : null;
      const cost = manual ?? (whCost != null ? D(whCost) : null);
      if (cost == null) continue;
      if (manual == null) est = true;
      acc = add(acc, mul(parseDraft(it.qty), cost));
    }
    return { costTotal: acc, costIsEstimate: est };
  }, [items, warehouse.data]);
  const total = useMemo(() => {
    const t = sub(subtotal, parseDraft(discount));
    return t.gt(0) ? t : D(0);
  }, [subtotal, discount]);
  const estEarnings = sub(total, costTotal);

  const collectItems = (): OrderItemInput[] | null => {
    const cleaned: OrderItemInput[] = [];
    for (const it of items) {
      if (!it.name.trim() || !it.unitPrice) continue;
      const price = parseAmountInput(it.unitPrice);
      if (!price) continue;
      const cost = it.unitCost ? parseAmountInput(it.unitCost) : null;
      cleaned.push({
        warehouseItemId: it.warehouseItemId ?? null,
        name: it.name.trim(),
        qty: it.qty,
        unitPrice: price,
        unitCost: cost,
      });
    }
    return cleaned.length ? cleaned : null;
  };

  const submitCreate = async () => {
    setError(null);
    const cleaned = collectItems();
    if (!cleaned) {
      setError('Добавьте хотя бы одну позицию с названием и ценой');
      return;
    }
    try {
      await create.mutateAsync({
        clientId: clientId || null,
        title: title.trim() || undefined,
        description: description.trim() || undefined,
        discountAmount: discount ? parseAmountInput(discount) ?? undefined : undefined,
        items: cleaned,
      });
      toast.success('Заказ создан');
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    }
  };

  const submitEdit = async () => {
    if (!editing) return;
    setError(null);
    const cleaned = collectItems();
    if (!cleaned) {
      setError('Добавьте хотя бы одну позицию с названием и ценой');
      return;
    }
    try {
      await update.mutateAsync({
        id: editing.id,
        clientId: clientId || null,
        title: title.trim() || null,
        description: description.trim() || null,
        discountAmount: discount ? parseAmountInput(discount) ?? undefined : '0',
        items: cleaned,
      });
      toast.success('Заказ обновлён');
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    }
  };

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" hideClose className="sm:max-w-lg">
        <SheetHeader className="flex-row items-center justify-between gap-2 space-y-0">
          <SheetTitle>{isEdit ? `Изменить ${editing?.number ?? 'заказ'}` : 'Новый заказ'}</SheetTitle>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Закрыть">
            <X className="h-4 w-4" />
          </Button>
        </SheetHeader>
        <SheetBody className="space-y-4">
          <FormField label="Клиент" htmlFor="o-client">
            <Select id="o-client" value={clientId} onChange={(e) => setClientId(e.target.value)}>
              <option value="">— Без клиента —</option>
              {(clients.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Название" htmlFor="o-title">
            <Input
              id="o-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="напр. «Сборка ПК для офиса»"
            />
          </FormField>
          <FormField label="Комментарий" htmlFor="o-description">
            <Textarea
              id="o-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Детали заказа: договорённости, сроки, нюансы"
              rows={3}
            />
          </FormField>

          <div className="space-y-3">
            <div className="text-sm font-medium">Позиции</div>
            {items.map((it, i) => {
              const wh = warehouse.data?.find((w) => w.id === it.warehouseItemId);
              return (
                <div key={i} className="space-y-1.5 rounded-md border border-border p-2.5">
                  <div className="flex items-center gap-2">
                    <Select
                      value={it.warehouseItemId ?? ''}
                      onChange={(e) => {
                        const id = e.target.value;
                        const item = warehouse.data?.find((w) => w.id === id);
                        setItems((arr) =>
                          arr.map((x, j) =>
                            j === i
                              ? {
                                  ...x,
                                  warehouseItemId: id || null,
                                  name: item ? item.name : x.name,
                                }
                              : x,
                          ),
                        );
                      }}
                      className="h-8 text-xs"
                    >
                      <option value="">Услуга / без склада</option>
                      {(warehouse.data ?? [])
                        .filter((w) => !w.isArchived)
                        .map((w) => (
                          <option key={w.id} value={w.id}>
                            {w.name}
                            {w.color ? ` · ${w.color}` : ''} (ост. {Number(w.qty)} {w.unit})
                          </option>
                        ))}
                    </Select>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setItems((arr) => arr.filter((_, j) => j !== i))}
                      aria-label="Удалить позицию"
                      disabled={items.length === 1}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <div className="flex items-end gap-2">
                    <div className="flex-1">
                      <Input
                        value={it.name}
                        onChange={(e) =>
                          setItems((arr) =>
                            arr.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)),
                          )
                        }
                        placeholder="Наименование"
                      />
                    </div>
                    <div className="w-14">
                      <Input
                        inputMode="decimal"
                        value={it.qty}
                        onChange={(e) =>
                          setItems((arr) =>
                            arr.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)),
                          )
                        }
                        placeholder="Кол."
                      />
                    </div>
                    <div className="w-24">
                      <Input
                        inputMode="decimal"
                        value={it.unitPrice}
                        onChange={(e) =>
                          setItems((arr) =>
                            arr.map((x, j) => (j === i ? { ...x, unitPrice: e.target.value } : x)),
                          )
                        }
                        placeholder="Цена прод."
                      />
                    </div>
                    <div className="w-24">
                      <Input
                        inputMode="decimal"
                        value={it.unitCost ?? ''}
                        onChange={(e) =>
                          setItems((arr) =>
                            arr.map((x, j) => (j === i ? { ...x, unitCost: e.target.value } : x)),
                          )
                        }
                        placeholder="Закупка"
                      />
                    </div>
                  </div>
                  {wh && !it.unitCost && (
                    <p className="text-xs text-muted-foreground">
                      Себест. со склада {formatRub(wh.avgCost)} · спишется при закрытии. Или впиши закупку вручную.
                    </p>
                  )}
                  {!it.warehouseItemId && it.unitCost && (
                    <p className="text-xs text-amber-600">
                      Эта себестоимость уже попадёт в прибыль как COGS при закрытии заказа.
                      Не заводи её повторно отдельной расходной операцией — будет двойной счёт.
                    </p>
                  )}
                </div>
              );
            })}
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                setItems((arr) => [
                  ...arr,
                  { warehouseItemId: null, name: '', qty: '1', unitPrice: '', unitCost: '' },
                ])
              }
            >
              <Plus className="h-3.5 w-3.5" /> Позиция
            </Button>
          </div>

          <FormField label="Скидка (₽)" htmlFor="o-discount">
            <Input
              id="o-discount"
              inputMode="decimal"
              value={discount}
              onChange={(e) => setDiscount(e.target.value)}
              placeholder="0"
            />
          </FormField>

          <div className="space-y-1 rounded-md border border-border bg-secondary/40 p-3 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Сумма позиций</span>
              <span className="tabular-nums">{formatRub(toMoneyString(subtotal))}</span>
            </div>
            {costTotal.gt(0) && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">
                  {costIsEstimate ? 'Себестоимость (оценка по складу)' : 'Себестоимость'}
                </span>
                <span className="tabular-nums">{formatRub(toMoneyString(costTotal))}</span>
              </div>
            )}
            <div className="flex justify-between font-semibold">
              <span>Итого к оплате</span>
              <span className="tabular-nums">{formatRub(toMoneyString(total))}</span>
            </div>
            {costTotal.gt(0) && (
              <div className="flex justify-between font-semibold text-success">
                <span>Заработок (план)</span>
                <span className="tabular-nums">
                  {costIsEstimate ? '≈ ' : ''}
                  {formatRub(toMoneyString(estEarnings))}
                </span>
              </div>
            )}
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </SheetBody>
        <SheetFooter>
          {isEdit ? (
            <>
              <Button variant="secondary" onClick={onClose} disabled={update.isPending}>
                Отмена
              </Button>
              <Button onClick={submitEdit} disabled={update.isPending}>
                {update.isPending ? 'Сохраняю…' : 'Сохранить'}
              </Button>
            </>
          ) : (
            <Button onClick={submitCreate} disabled={create.isPending}>
              {create.isPending ? 'Создаю…' : 'Создать заказ'}
            </Button>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

// ─────────────────────────── Order detail / manage ───────────────────────────

function OrderDetailSheet({
  wsId,
  orderId,
  onClose,
  onEdit,
}: {
  wsId: string;
  orderId: string | null;
  onClose: () => void;
  onEdit: (order: Order) => void;
}) {
  const { data: order, isLoading } = useOrder(wsId, orderId);
  const accounts = useAccounts(wsId);
  const addPayment = useAddOrderPayment(wsId);
  const finalize = useFinalizeOrder(wsId);
  const cancel = useCancelOrder(wsId);
  const reopen = useReopenOrder(wsId);
  const uploadAtt = useUploadOrderAttachment(wsId);
  const deleteAtt = useDeleteOrderAttachment(wsId);

  const [payAmount, setPayAmount] = useState('');
  const [payAccount, setPayAccount] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmDeleteAtt, setConfirmDeleteAtt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onPay = async () => {
    if (!orderId) return;
    setError(null);
    const amount = parseAmountInput(payAmount);
    if (!amount) {
      setError('Некорректная сумма');
      return;
    }
    if (!payAccount) {
      setError('Выберите счёт');
      return;
    }
    try {
      await addPayment.mutateAsync({ id: orderId, amount, accountId: payAccount });
      setPayAmount('');
      toast.success('Оплата добавлена');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    }
  };

  return (
    <>
      <Sheet open={!!orderId} onOpenChange={(o) => !o && onClose()}>
        <SheetContent side="right" hideClose className="sm:max-w-lg">
          <SheetHeader className="flex-row items-center justify-between gap-2 space-y-0">
            <SheetTitle>{order ? order.number : 'Заказ'}</SheetTitle>
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="Закрыть">
              <X className="h-4 w-4" />
            </Button>
          </SheetHeader>

          <SheetBody className="space-y-5">
            {isLoading || !order ? (
              <p className="text-sm text-muted-foreground">Загрузка…</p>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={STATUS_VARIANT[order.status]}>
                    {STATUS_LABEL[order.status]}
                  </Badge>
                  <Badge variant={PAY_VARIANT[order.paymentStatus]}>
                    {PAY_LABEL[order.paymentStatus]}
                  </Badge>
                  {order.client && (
                    <span className="text-sm text-muted-foreground">· {order.client.name}</span>
                  )}
                </div>

                {order.title && <p className="text-sm">{order.title}</p>}
                {order.description && (
                  <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                    {order.description}
                  </p>
                )}

                {/* Items */}
                <div className="overflow-hidden rounded-md border border-border">
                  <table className="w-full text-sm">
                    <thead className="border-b border-border bg-secondary/40">
                      <tr className="text-left text-xs uppercase text-muted-foreground">
                        <th className="px-3 py-2 font-medium">Позиция</th>
                        <th className="px-3 py-2 text-right font-medium">Кол-во</th>
                        <th className="px-3 py-2 text-right font-medium">Цена</th>
                        <th className="px-3 py-2 text-right font-medium">Сумма</th>
                        <th className="px-3 py-2 text-right font-medium">Маржа</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(order.items ?? []).map((it) => (
                        <tr key={it.id} className="border-b border-border last:border-0">
                          <td className="px-3 py-2">{it.name}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{it.qty}</td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {formatRub(it.unitPrice)}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {formatRub(it.lineTotal)}
                          </td>
                          {/* Маржа строки — с бэкенда (netQty за вычетом возвратов);
                              «≈» — себестоимость пока оценка по складу (до выдачи). */}
                          <td className="px-3 py-2 text-right tabular-nums">
                            {it.margin ? (
                              <>
                                <div>
                                  {it.margin.costSource === 'estimate' && '≈ '}
                                  {formatRub(it.margin.margin)}
                                </div>
                                <div className="text-xs text-muted-foreground">
                                  {it.margin.marginPct}%
                                </div>
                              </>
                            ) : (
                              '—'
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Totals */}
                <div className="space-y-1 text-sm">
                  <Row label="Сумма позиций" value={formatRub(order.subtotal)} />
                  {D(order.discountAmount).gt(0) && (
                    <Row label="Скидка" value={`−${formatRub(order.discountAmount)}`} />
                  )}
                  <Row label="Итого" value={formatRub(order.totalAmount)} strong />
                  <Row
                    label="Оплачено"
                    value={formatRub(order.paidAmount)}
                    tone={D(order.paidAmount).gte(order.totalAmount) ? 'pos' : undefined}
                  />
                  <Row
                    label="Остаток"
                    value={formatRub(
                      toMoneyString(
                        (() => {
                          const due = sub(order.totalAmount, order.paidAmount);
                          return due.gt(0) ? due : D(0);
                        })(),
                      ),
                    )}
                  />
                </div>

                {/* Маржа заказа — считает бэкенд (F1, решение #4): доход =
                    реализация (totalAmount за вычетом возвратов), НЕ оплата.
                    «Оценка по складу» — до выдачи себестоимость складских строк
                    берётся по текущей стоимости остатка (avgCost). */}
                {order.margin &&
                  !(order.margin.revenue === '0.00' && order.margin.cogs === '0.00') && (
                    <div className="space-y-1 rounded-md border border-border bg-secondary/40 p-3 text-sm">
                      <Row
                        label="Доход (реализация)"
                        value={formatRub(order.margin.revenue)}
                        tone="pos"
                      />
                      <Row
                        label={
                          order.margin.isEstimate
                            ? 'Расход (себестоимость, оценка по складу)'
                            : 'Расход (себестоимость)'
                        }
                        value={formatRub(order.margin.cogs)}
                      />
                      <Row
                        label="Прибыль"
                        value={`${order.margin.isEstimate ? '≈ ' : ''}${formatRub(order.margin.margin)} · ${order.margin.marginPct}%`}
                        strong
                        tone={D(order.margin.margin).gte(0) ? 'pos' : undefined}
                      />
                    </div>
                  )}

                {/* Чеки / документы */}
                <div>
                  <div className="mb-1.5 text-xs font-medium uppercase text-muted-foreground">
                    Чеки и документы
                  </div>
                  <div className="space-y-1.5">
                    {(order.attachments ?? []).map((a) => (
                      <div
                        key={a.id}
                        className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm"
                      >
                        <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <a
                          href={`/api/v1/workspaces/${wsId}/attachments/${a.id}/download`}
                          className="flex-1 truncate text-primary hover:underline"
                        >
                          {a.filename}
                        </a>
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {(a.size / 1024).toFixed(0)} KB
                        </span>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteAtt(a.id)}
                          aria-label="Удалить чек"
                          className="text-destructive transition-colors hover:opacity-80"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                    <label className="flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-secondary">
                      <Paperclip className="h-3.5 w-3.5" />
                      {uploadAtt.isPending ? 'Загружаю…' : 'Прикрепить чек'}
                      <input
                        type="file"
                        className="hidden"
                        disabled={uploadAtt.isPending}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f && order) uploadAtt.mutate({ orderId: order.id, file: f });
                          e.target.value = '';
                        }}
                      />
                    </label>
                  </div>
                </div>

                {/* Payments log */}
                {order.transactions && order.transactions.length > 0 && (
                  <div>
                    <div className="mb-1.5 text-xs font-medium uppercase text-muted-foreground">
                      Платежи
                    </div>
                    <div className="space-y-1">
                      {order.transactions.map((t) => (
                        <div
                          key={t.id}
                          className="flex items-center justify-between rounded-md border border-border px-3 py-1.5 text-sm"
                        >
                          <span className="text-muted-foreground">
                            {DATE_FMT.format(new Date(t.date))} ·{' '}
                            {t.kind === 'ORDER_REFUND' ? 'возврат' : 'оплата'}
                          </span>
                          <span
                            className={cn(
                              'tabular-nums',
                              t.kind === 'ORDER_REFUND' ? 'text-destructive' : 'text-success',
                            )}
                          >
                            {t.kind === 'ORDER_REFUND' ? '−' : '+'}
                            {formatRub(t.amount)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Add payment */}
                {order.status !== 'CANCELLED' && (
                  <div className="space-y-2 rounded-md border border-border p-3">
                    <div className="text-sm font-medium">Принять оплату</div>
                    <div className="flex items-end gap-2">
                      <div className="w-32">
                        <Input
                          inputMode="decimal"
                          value={payAmount}
                          onChange={(e) => setPayAmount(e.target.value)}
                          placeholder="Сумма"
                        />
                      </div>
                      <div className="flex-1">
                        <Select value={payAccount} onChange={(e) => setPayAccount(e.target.value)}>
                          <option value="">— Счёт —</option>
                          {(accounts.data ?? [])
                            .filter((a) => !a.isArchived)
                            .map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.name}
                              </option>
                            ))}
                        </Select>
                      </div>
                      <Button onClick={onPay} disabled={addPayment.isPending}>
                        Добавить
                      </Button>
                    </div>
                  </div>
                )}

                {error && <p className="text-sm text-destructive">{error}</p>}
              </>
            )}
          </SheetBody>

          {order && order.status !== 'CANCELLED' && (
            <SheetFooter className="flex-wrap">
              <Button
                variant="destructive"
                onClick={() => setConfirmCancel(true)}
                className="sm:mr-auto"
              >
                Отменить
              </Button>
              {order.status === 'DONE' ? (
                <Button
                  variant="secondary"
                  onClick={() => reopen.mutate(order.id)}
                  disabled={reopen.isPending}
                >
                  {reopen.isPending ? 'Возвращаю…' : 'Вернуть в работу'}
                </Button>
              ) : (
                <>
                  <Button variant="secondary" onClick={() => onEdit(order)}>
                    Изменить
                  </Button>
                  <Button onClick={() => finalize.mutate(order.id)} disabled={finalize.isPending}>
                    {finalize.isPending ? 'Закрываю…' : 'Закрыть заказ'}
                  </Button>
                </>
              )}
            </SheetFooter>
          )}

          {order && order.status === 'CANCELLED' && (
            <SheetFooter className="flex-wrap">
              <p className="mr-auto text-xs text-muted-foreground">
                Заказ отменён. Верните в работу, чтобы отредактировать позиции и закрыть заново.
              </p>
              <Button
                variant="secondary"
                onClick={() => reopen.mutate(order.id)}
                disabled={reopen.isPending}
              >
                {reopen.isPending ? 'Возвращаю…' : 'Вернуть в работу'}
              </Button>
            </SheetFooter>
          )}
        </SheetContent>
      </Sheet>

      <ConfirmDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title="Отменить заказ?"
        description="Статус станет «Отменён». Платежи останутся — при необходимости оформите возврат."
        confirmText="Отменить заказ"
        onConfirm={async () => {
          if (order) await cancel.mutateAsync(order.id);
          setConfirmCancel(false);
        }}
        loading={cancel.isPending}
      />

      <ConfirmDialog
        open={confirmDeleteAtt !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDeleteAtt(null);
        }}
        title="Удалить чек?"
        description="Файл будет удалён без возможности восстановления."
        confirmText="Удалить"
        onConfirm={async () => {
          if (confirmDeleteAtt) await deleteAtt.mutateAsync(confirmDeleteAtt);
          setConfirmDeleteAtt(null);
        }}
        loading={deleteAtt.isPending}
      />
    </>
  );
}

function Row({
  label,
  value,
  strong,
  tone,
}: {
  label: string;
  value: string;
  strong?: boolean;
  tone?: 'pos';
}) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={cn(
          'tabular-nums',
          strong && 'font-semibold',
          tone === 'pos' && 'text-success',
        )}
      >
        {value}
      </span>
    </div>
  );
}
