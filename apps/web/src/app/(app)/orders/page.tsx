'use client';

import { useMemo, useState } from 'react';
import { Plus, ClipboardList, X, Trash2, Paperclip } from 'lucide-react';
import { formatRub, parseAmountInput } from '@construct/shared';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useCounterparties } from '@/hooks/useCounterparties';
import { useAccounts } from '@/hooks/useAccounts';
import { useWarehouse } from '@/hooks/useWarehouse';
import {
  useOrders,
  useOrder,
  useCreateOrder,
  useAddOrderPayment,
  useFinalizeOrder,
  useCancelOrder,
  useUploadOrderAttachment,
  useDeleteOrderAttachment,
  type OrderItemInput,
} from '@/hooks/useOrders';
import type { Order, OrderStatus, OrderPaymentState } from '@/lib/types';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
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
  DRAFT: 'Черновик',
  OPEN: 'В работе',
  DONE: 'Выполнен',
  CANCELLED: 'Отменён',
};
const STATUS_VARIANT: Record<OrderStatus, BadgeProps['variant']> = {
  DRAFT: 'muted',
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

  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

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
            <option value="DRAFT">Черновик</option>
            <option value="OPEN">В работе</option>
            <option value="DONE">Выполнен</option>
            <option value="CANCELLED">Отменён</option>
          </Select>
        </label>
      </FilterBar>

      <div className="bg-card">
        <DataTable
          data={orders.data ?? []}
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
      </div>

      <CreateOrderSheet
        wsId={current.id}
        open={creating}
        onClose={() => setCreating(false)}
      />
      <OrderDetailSheet
        wsId={current.id}
        orderId={openId}
        onClose={() => setOpenId(null)}
      />
    </>
  );
}

// ─────────────────────────── Create order ───────────────────────────

function CreateOrderSheet({
  wsId,
  open,
  onClose,
}: {
  wsId: string;
  open: boolean;
  onClose: () => void;
}) {
  const clients = useCounterparties(wsId, undefined, false, 'CLIENT');
  const warehouse = useWarehouse(wsId);
  const create = useCreateOrder(wsId);

  const [clientId, setClientId] = useState('');
  const [title, setTitle] = useState('');
  const [discount, setDiscount] = useState('');
  const [items, setItems] = useState<OrderItemInput[]>([
    { name: '', qty: '1', unitPrice: '', unitCost: '' },
  ]);
  const [error, setError] = useState<string | null>(null);

  const subtotal = useMemo(
    () =>
      items.reduce((acc, it) => {
        const q = Number(it.qty) || 0;
        const p = Number(it.unitPrice) || 0;
        return acc + q * p;
      }, 0),
    [items],
  );
  const costTotal = useMemo(
    () =>
      items.reduce((acc, it) => {
        const q = Number(it.qty) || 0;
        const c = Number(it.unitCost) || 0;
        return acc + q * c;
      }, 0),
    [items],
  );
  const total = Math.max(0, subtotal - (Number(discount) || 0));
  const estEarnings = total - costTotal;

  const reset = () => {
    setClientId('');
    setTitle('');
    setDiscount('');
    setItems([{ name: '', qty: '1', unitPrice: '', unitCost: '' }]);
    setError(null);
  };

  const submit = async (asOpen: boolean) => {
    setError(null);
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
    if (cleaned.length === 0) {
      setError('Добавьте хотя бы одну позицию с названием и ценой');
      return;
    }
    try {
      await create.mutateAsync({
        clientId: clientId || null,
        title: title.trim() || undefined,
        discountAmount: discount ? parseAmountInput(discount) ?? undefined : undefined,
        open: asOpen,
        items: cleaned,
      });
      toast.success(asOpen ? 'Заказ создан и в работе' : 'Черновик заказа создан');
      reset();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    }
  };

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" hideClose className="sm:max-w-lg">
        <SheetHeader className="flex-row items-center justify-between gap-2 space-y-0">
          <SheetTitle>Новый заказ</SheetTitle>
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
          <FormField label="Название / описание" htmlFor="o-title">
            <Input
              id="o-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="напр. «Сборка ПК для офиса»"
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
                            {w.name} (ост. {Number(w.qty)} {w.unit})
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
              <span className="tabular-nums">{formatRub(subtotal)}</span>
            </div>
            {costTotal > 0 && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Себестоимость</span>
                <span className="tabular-nums">{formatRub(costTotal)}</span>
              </div>
            )}
            <div className="flex justify-between font-semibold">
              <span>Итого к оплате</span>
              <span className="tabular-nums">{formatRub(total)}</span>
            </div>
            {costTotal > 0 && (
              <div className="flex justify-between font-semibold text-success">
                <span>Заработок (план)</span>
                <span className="tabular-nums">{formatRub(estEarnings)}</span>
              </div>
            )}
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </SheetBody>
        <SheetFooter>
          <Button variant="secondary" onClick={() => submit(false)} disabled={create.isPending}>
            В черновик
          </Button>
          <Button onClick={() => submit(true)} disabled={create.isPending}>
            {create.isPending ? 'Создаю…' : 'Создать и в работу'}
          </Button>
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
}: {
  wsId: string;
  orderId: string | null;
  onClose: () => void;
}) {
  const { data: order, isLoading } = useOrder(wsId, orderId);
  const accounts = useAccounts(wsId);
  const addPayment = useAddOrderPayment(wsId);
  const finalize = useFinalizeOrder(wsId);
  const cancel = useCancelOrder(wsId);
  const uploadAtt = useUploadOrderAttachment(wsId);
  const deleteAtt = useDeleteOrderAttachment(wsId);

  const [payAmount, setPayAmount] = useState('');
  const [payAccount, setPayAccount] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);
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

                {/* Items */}
                <div className="overflow-hidden rounded-md border border-border">
                  <table className="w-full text-sm">
                    <thead className="border-b border-border bg-secondary/40">
                      <tr className="text-left text-xs uppercase text-muted-foreground">
                        <th className="px-3 py-2 font-medium">Позиция</th>
                        <th className="px-3 py-2 text-right font-medium">Кол-во</th>
                        <th className="px-3 py-2 text-right font-medium">Цена</th>
                        <th className="px-3 py-2 text-right font-medium">Сумма</th>
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
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Totals */}
                <div className="space-y-1 text-sm">
                  <Row label="Сумма позиций" value={formatRub(order.subtotal)} />
                  {Number(order.discountAmount) > 0 && (
                    <Row label="Скидка" value={`−${formatRub(order.discountAmount)}`} />
                  )}
                  <Row label="Итого" value={formatRub(order.totalAmount)} strong />
                  <Row
                    label="Оплачено"
                    value={formatRub(order.paidAmount)}
                    tone={Number(order.paidAmount) >= Number(order.totalAmount) ? 'pos' : undefined}
                  />
                  <Row
                    label="Остаток"
                    value={formatRub(Math.max(0, Number(order.totalAmount) - Number(order.paidAmount)))}
                  />
                </div>

                {/* Себестоимость и заработок: cost = unitCost (ручной) ?? WAVG-снапшот */}
                {(() => {
                  const cost = (order.items ?? []).reduce((acc, it) => {
                    const c = it.unitCost ?? it.unitCostAtSale;
                    return acc + (c ? Number(it.qty) * Number(c) : 0);
                  }, 0);
                  if (cost <= 0) return null;
                  const paid = Number(order.paidAmount);
                  const earnings = paid - cost; // по факту денег
                  const earnPct = paid > 0 ? (earnings / paid) * 100 : 0;
                  const planMargin = Number(order.totalAmount) - cost;
                  return (
                    <div className="space-y-1 rounded-md border border-border bg-secondary/40 p-3 text-sm">
                      <Row label="Себестоимость" value={formatRub(cost)} />
                      <Row label="Маржа (план, по сумме заказа)" value={formatRub(planMargin)} />
                      <Row
                        label="Заработок (оплачено − себест.)"
                        value={`${formatRub(earnings)}${paid > 0 ? ` · ${earnPct.toFixed(0)}%` : ''}`}
                        strong
                        tone={earnings >= 0 ? 'pos' : undefined}
                      />
                    </div>
                  );
                })()}

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
                          onClick={() => deleteAtt.mutate(a.id)}
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
            <SheetFooter>
              <Button
                variant="destructive"
                onClick={() => setConfirmCancel(true)}
                className="sm:mr-auto"
              >
                Отменить заказ
              </Button>
              {order.status !== 'DONE' && (
                <Button onClick={() => finalize.mutate(order.id)} disabled={finalize.isPending}>
                  {finalize.isPending ? 'Закрываю…' : 'Закрыть заказ'}
                </Button>
              )}
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
