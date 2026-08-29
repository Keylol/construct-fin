'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, ClipboardList, X, Trash2, Paperclip } from '@/components/ui/icons';
import {
  formatRub,
  parseAmountInput,
  parseOrderItemsText,
  allocateSalePrices,
  D,
  add,
  sub,
  mul,
  toMoneyString,
} from '@construct/shared';
import { useCurrentWorkspace } from '@/hooks/useCurrentWorkspace';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useCreateFromUrl } from '@/hooks/useCreateFromUrl';
import { useCounterparties } from '@/hooks/useCounterparties';
import { useAccounts } from '@/hooks/useAccounts';
import { useWarehouse } from '@/hooks/useWarehouse';
import {
  useOrders,
  useOrder,
  useCreateOrder,
  useUpdateOrder,
  useAddOrderPayment,
  useAddInstallmentPayment,
  useDeleteOrderPayment,
  useFinalizeOrder,
  useCancelOrder,
  useReopenOrder,
  useSetOrderSchedule,
  useOrderTrace,
  useUploadOrderAttachment,
  useDeleteOrderAttachment,
  type OrderItemInput,
  type ScheduleEntryInput,
} from '@/hooks/useOrders';
import type {
  Order,
  OrderStatus,
  OrderPaymentState,
  ScheduleEntryStatus,
} from '@/lib/types';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Select } from '@/components/ui/Select';
import { Badge, type BadgeProps } from '@/components/ui/Badge';
import { StatusDot } from '@/components/ui/StatusDot';
import { StatusStamp } from '@/components/ui/StatusStamp';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs';
import { EmptyState } from '@/components/ui/EmptyState';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { FormField } from '@/components/ui/FormField';
import { FilterBar } from '@/components/ui/FilterBar';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Combobox } from '@/components/ui/Combobox';
import { QuickCreateCounterpartyDialog } from '@/components/counterparties/QuickCreateCounterpartyDialog';
import { FindPaymentPanel } from '@/components/orders/FindPaymentPanel';
import { toLocalDateInput, fromLocalDateInput } from '@/lib/periods';
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
import { formatDate } from '@/lib/dates';

const STATUS_LABEL: Record<OrderStatus, string> = {
  OPEN: 'В работе',
  DONE: 'Закрыт',
  CANCELLED: 'Отменён',
};
// Тон точки/штампа (решение №15/№3): статус — вторичный сигнал, не пилюля.
type StatusTone = 'success' | 'warning' | 'destructive' | 'muted' | 'primary';
const STATUS_TONE: Record<OrderStatus, StatusTone> = {
  OPEN: 'primary',
  DONE: 'success',
  CANCELLED: 'muted',
};
const PAY_LABEL: Record<OrderPaymentState, string> = {
  UNPAID: 'Не оплачен',
  PARTIAL: 'Частично',
  PAID: 'Оплачен',
  OVERPAID: 'Переплата',
  REFUNDED: 'Возврат',
};
const PAY_TONE: Record<OrderPaymentState, StatusTone> = {
  UNPAID: 'muted',
  PARTIAL: 'warning',
  PAID: 'success',
  OVERPAID: 'warning',
  REFUNDED: 'destructive',
};

const SCHED_LABEL: Record<ScheduleEntryStatus, string> = {
  PAID: 'Оплачен',
  PARTIAL: 'Частично',
  PENDING: 'Ожидается',
  OVERDUE: 'Просрочен',
};
const SCHED_VARIANT: Record<ScheduleEntryStatus, BadgeProps['variant']> = {
  PAID: 'success',
  PARTIAL: 'outline',
  PENDING: 'muted',
  OVERDUE: 'destructive',
};

export default function OrdersPage() {
  const { current } = useCurrentWorkspace();
  const wsId = current?.id ?? null;
  const [statusFilter, setStatusFilter] = useState<OrderStatus | ''>('');
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

  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Order | null>(null);
  // Глобальное «+ Создать» → ?new=1 открывает форму заказа.
  useCreateFromUrl(() => setCreating(true));

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
        </div>
      ),
      className: 'w-[150px]',
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
      cell: (o) => <span className="font-semibold tabular-nums">{formatRub(o.totalAmount)}</span>,
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
      </FilterBar>

      <div className="bg-card">
        <DataTable
          data={orderRows}
          columns={columns}
          rowKey={(o) => o.id}
          onRowClick={(o) => setOpenId(o.id)}
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
                <span className="font-semibold tabular-nums">{formatRub(o.totalAmount)}</span>
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
  const accounts = useAccounts(wsId);
  const create = useCreateOrder(wsId);
  const update = useUpdateOrder(wsId);
  const setSchedule = useSetOrderSchedule(wsId);
  const addPayment = useAddOrderPayment(wsId);

  const [clientId, setClientId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [discount, setDiscount] = useState('');
  const [items, setItems] = useState<OrderItemInput[]>([
    { name: '', qty: '1', unitPrice: '', unitCost: '' },
  ]);
  const [error, setError] = useState<string | null>(null);
  // Ошибки по строкам позиций: индекс строки → текст. Невалидная строка больше
  // не выбрасывается молча — подсвечивается и блокирует сабмит.
  const [itemErrors, setItemErrors] = useState<Record<number, string>>({});
  const [confirmClose, setConfirmClose] = useState(false);
  // «+ Создать клиента» из комбобокса: null = закрыто, строка = префилл имени.
  const [createClientQuery, setCreateClientQuery] = useState<string | null>(null);

  // ── Состав текстом и распределение цены (P0.1) ──
  // Спецификация заказа приходит списком (docx поставщика, заметка, таблица), а
  // сборка из восьми позиций — это 26 полей ручного ввода. Текстовое поле
  // переносит её целиком; цены продажи раскидываются по закупке одной кнопкой.
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [allocTotal, setAllocTotal] = useState('');

  // ── План оплаты (только при СОЗДАНИИ; в правке платежи/график — в детали) ──
  // 'none' — без оплаты, 'full' — оплата сразу 100%, 'schedule' — свой график.
  // Предоплата = реальные деньги сейчас (решение владельца): пишется платежом.
  const [payMode, setPayMode] = useState<'none' | 'full' | 'schedule'>('none');
  const [prepayAmount, setPrepayAmount] = useState('');
  const [prepayAccount, setPrepayAccount] = useState('');
  const [payAccountFull, setPayAccountFull] = useState('');
  const [scheduleRows, setScheduleRows] = useState<{ dueDate: string; amount: string }[]>([]);
  const [payError, setPayError] = useState<string | null>(null);

  const accountOptions = useMemo(
    () =>
      (accounts.data ?? [])
        .filter((a) => !a.isArchived)
        .map((a) => ({ value: a.id, label: a.name })),
    [accounts.data],
  );

  // SKU со вторичной строкой (остаток, себестоимость) — для строк позиций.
  const skuOptions = useMemo(
    () =>
      (warehouse.data ?? [])
        .filter((w) => !w.isArchived)
        .map((w) => ({
          value: w.id,
          label: w.color ? `${w.name} · ${w.color}` : w.name,
          description: `ост. ${Number(w.qty)} ${w.unit}${
            Number(w.avgCost) > 0 ? ` · себест. ${formatRub(w.avgCost)}` : ''
          }`,
          keywords: w.sku ? [w.sku] : undefined,
        })),
    [warehouse.data],
  );
  // Снимок состояния на момент открытия — для guard «Закрыть без сохранения?».
  const initialSnap = useRef('');

  const snapOf = (
    cl: string,
    t: string,
    d: string,
    disc: string,
    its: OrderItemInput[],
  ) =>
    JSON.stringify({
      cl,
      t,
      d,
      disc,
      its: its.map((it) => ({
        w: it.warehouseItemId ?? null,
        n: it.name,
        q: it.qty,
        p: it.unitPrice,
        c: it.unitCost ?? '',
      })),
    });

  // Префилл при открытии на редактирование.
  useEffect(() => {
    if (!open) return;
    if (editing) {
      const nextItems = (editing.items ?? []).map((it) => ({
        warehouseItemId: it.warehouseItemId,
        name: it.name,
        qty: String(Number(it.qty)),
        unitPrice: String(Number(it.unitPrice)),
        unitCost: it.unitCost ? String(Number(it.unitCost)) : '',
      }));
      const nextDiscount =
        Number(editing.discountAmount) > 0 ? String(Number(editing.discountAmount)) : '';
      setClientId(editing.clientId ?? '');
      setTitle(editing.title ?? '');
      setDescription(editing.description ?? '');
      setDiscount(nextDiscount);
      setItems(nextItems);
      initialSnap.current = snapOf(
        editing.clientId ?? '',
        editing.title ?? '',
        editing.description ?? '',
        nextDiscount,
        nextItems,
      );
    } else {
      const nextItems = [{ warehouseItemId: null, name: '', qty: '1', unitPrice: '', unitCost: '' }];
      setClientId('');
      setTitle('');
      setDescription('');
      setDiscount('');
      setItems(nextItems);
      initialSnap.current = snapOf('', '', '', '', nextItems);
    }
    setError(null);
    setItemErrors({});
    setPasteOpen(false);
    setPasteText('');
    setAllocTotal('');
    // Сброс плана оплаты.
    setPayMode('none');
    setPrepayAmount('');
    setPrepayAccount('');
    setPayAccountFull('');
    setScheduleRows([]);
    setPayError(null);
  }, [open, editing]);

  const isDirty =
    snapOf(clientId, title, description, discount, items) !== initialSnap.current ||
    // Незакрытый план оплаты при создании — тоже несохранённое состояние.
    (!isEdit && payMode !== 'none');

  // Закрытие через guard: заполненная форма не стирается молча по Esc/оверлею.
  const requestClose = () => {
    if (isDirty && !create.isPending && !update.isPending) {
      setConfirmClose(true);
    } else {
      onClose();
    }
  };

  // Правка строки позиции + сброс её ошибки (пользователь начал исправлять).
  const patchItem = (i: number, patch: Partial<OrderItemInput>) => {
    setItems((arr) => arr.map((x, j) => (j === i ? { ...x, ...patch } : x)));
    setItemErrors((prev) => {
      if (!(i in prev)) return prev;
      const next = { ...prev };
      delete next[i];
      return next;
    });
  };

  // Разбор вставленного текста считаем на каждый ввод — человек видит, что
  // распозналось, ДО того как строки заменят форму.
  const pasteParsed = useMemo(() => parseOrderItemsText(pasteText), [pasteText]);

  const applyPaste = (mode: 'replace' | 'append') => {
    const parsed = pasteParsed.items.map((it) => ({
      warehouseItemId: null,
      name: it.name,
      qty: it.qty,
      unitPrice: it.unitPrice,
      unitCost: it.unitCost,
    }));
    if (!parsed.length) return;
    setItems((arr) => {
      if (mode === 'replace') return parsed;
      // Запасная пустая строка формы не должна оставаться между вставками.
      const kept = arr.filter((it) => it.name.trim() || it.unitPrice.trim() || it.warehouseItemId);
      return [...kept, ...parsed];
    });
    setItemErrors({});
    setPasteText('');
    setPasteOpen(false);
    toast.success(`Позиций добавлено: ${parsed.length}`);
  };

  const applyAllocation = () => {
    const target = parseAmountInput(allocTotal);
    if (!target || !D(target).gt(0)) {
      setError('Итог для распределения — число больше нуля');
      return;
    }
    const filled = items.filter((it) => it.name.trim() || it.unitCost?.trim());
    if (!filled.length) {
      setError('Сначала заполните позиции — распределять пока не на что');
      return;
    }
    const prices = allocateSalePrices(
      filled.map((it) => ({ qty: it.qty || '1', unitCost: it.unitCost ?? '' })),
      target,
    );
    let k = 0;
    setItems((arr) =>
      arr.map((it) => {
        const counts = it.name.trim() || it.unitCost?.trim();
        if (!counts) return it;
        const price = prices[k++] ?? it.unitPrice;
        return { ...it, unitPrice: price };
      }),
    );
    setError(null);
  };

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

  // Честная валидация: полностью пустые строки игнорируются (запасная строка),
  // но частично заполненная невалидная строка — это ошибка, а не молчаливый
  // выброс (иначе заказ тихо создаётся без части позиций).
  const collectItems = ():
    | { ok: true; items: OrderItemInput[] }
    | { ok: false; errors: Record<number, string> } => {
    const cleaned: OrderItemInput[] = [];
    const errors: Record<number, string> = {};
    items.forEach((it, i) => {
      const blank = !it.name.trim() && !it.unitPrice.trim() && !it.warehouseItemId;
      if (blank) return;
      if (!it.name.trim()) {
        errors[i] = 'Укажите наименование';
        return;
      }
      const price = parseAmountInput(it.unitPrice);
      if (!price) {
        errors[i] = 'Укажите цену продажи — число больше нуля';
        return;
      }
      if (!parseDraft(it.qty).gt(0)) {
        errors[i] = 'Количество должно быть больше нуля';
        return;
      }
      if (it.unitCost && !parseAmountInput(it.unitCost)) {
        errors[i] = 'Закупочная цена — некорректное число';
        return;
      }
      const cost = it.unitCost ? parseAmountInput(it.unitCost) : null;
      cleaned.push({
        warehouseItemId: it.warehouseItemId ?? null,
        name: it.name.trim(),
        qty: it.qty,
        unitPrice: price,
        unitCost: cost,
      });
    });
    if (Object.keys(errors).length) return { ok: false, errors };
    return { ok: true, items: cleaned };
  };

  // Σ плана: предоплата сейчас + сумма графика остатка. Сверяется с итогом заказа.
  const prepayDraft = payMode === 'full' ? total : parseDraft(prepayAmount);
  const scheduleDraft = scheduleRows.reduce((acc, r) => add(acc, parseDraft(r.amount)), D(0));
  const planTotal = add(prepayDraft, scheduleDraft);
  const planMatchesTotal = planTotal.eq(total);

  // Валидация плана оплаты (только при создании). Возвращает шаги для оркестрации
  // или ошибку. Предоплата = реальные деньги сейчас → требует счёт.
  const collectPaymentPlan = ():
    | { ok: true; prepay: { amount: string; accountId: string } | null; schedule: ScheduleEntryInput[] }
    | { ok: false; error: string } => {
    if (payMode === 'none') return { ok: true, prepay: null, schedule: [] };

    const todayIso = fromLocalDateInput(toLocalDateInput(new Date()));

    if (payMode === 'full') {
      if (!total.gt(0)) return { ok: false, error: 'Сумма заказа — 0, оплачивать нечего' };
      if (!payAccountFull) return { ok: false, error: 'Выберите счёт для оплаты' };
      const amount = toMoneyString(total);
      return {
        ok: true,
        prepay: { amount, accountId: payAccountFull },
        // График не нужен — заказ оплачен полностью.
        schedule: [],
      };
    }

    // payMode === 'schedule': предоплата (опц.) + строки остатка.
    let prepay: { amount: string; accountId: string } | null = null;
    const entries: ScheduleEntryInput[] = [];

    const prepayVal = parseAmountInput(prepayAmount);
    if (prepayAmount.trim() && !prepayVal) {
      return { ok: false, error: 'Сумма предоплаты указана некорректно' };
    }
    if (prepayVal && D(prepayVal).gt(0)) {
      if (!prepayAccount) return { ok: false, error: 'Выберите счёт для предоплаты' };
      prepay = { amount: prepayVal, accountId: prepayAccount };
      // Предоплата — первая строка графика (срок сегодня), чтобы FIFO-покрытие
      // и сверка с итогом сходились.
      entries.push({ dueDate: todayIso, amount: prepayVal, note: 'Предоплата' });
    }

    for (const r of scheduleRows) {
      if (!r.dueDate && !r.amount.trim()) continue;
      const amount = parseAmountInput(r.amount);
      if (!r.dueDate || !amount || D(amount).lte(0)) {
        return { ok: false, error: 'В каждой строке графика нужны дата и положительная сумма' };
      }
      entries.push({ dueDate: fromLocalDateInput(r.dueDate), amount });
    }

    if (!prepay && entries.length === 0) {
      return { ok: false, error: 'Добавьте предоплату или строки графика (или выберите «Без оплаты»)' };
    }
    return { ok: true, prepay, schedule: entries };
  };

  const submitCreate = async () => {
    setError(null);
    setPayError(null);
    const collected = collectItems();
    if (!collected.ok) {
      setItemErrors(collected.errors);
      setError('Исправьте выделенные позиции — они не будут сохранены в таком виде');
      return;
    }
    const cleaned = collected.items;
    if (!cleaned.length) {
      setError('Добавьте хотя бы одну позицию с названием и ценой');
      return;
    }
    const plan = collectPaymentPlan();
    if (!plan.ok) {
      setPayError(plan.error);
      return;
    }
    try {
      const order = await create.mutateAsync({
        clientId: clientId || null,
        title: title.trim() || undefined,
        description: description.trim() || undefined,
        discountAmount: discount ? parseAmountInput(discount) ?? undefined : undefined,
        items: cleaned,
      });
      // Заказ создан. Дальнейшие шаги оплаты — необязательные и восстановимые:
      // при сбое заказ НЕ теряется, сообщаем «внесите вручную в карточке».
      try {
        if (plan.schedule.length > 0) {
          await setSchedule.mutateAsync({ id: order.id, entries: plan.schedule });
        }
        if (plan.prepay) {
          await addPayment.mutateAsync({
            id: order.id,
            // Для «оплата 100%» берём авторитетную сумму созданного заказа
            // (бэкенд считает total из позиций/скидки) — платёж копейка-в-копейку.
            amount: payMode === 'full' ? order.totalAmount : plan.prepay.amount,
            accountId: plan.prepay.accountId,
          });
        }
        toast.success('Заказ создан', {
          description:
            plan.prepay || plan.schedule.length ? 'План оплаты сохранён' : undefined,
        });
      } catch (payErr) {
        toast.warning('Заказ создан, но оплату записать не удалось', {
          description: `${payErr instanceof Error ? payErr.message : 'Ошибка'}. Внесите оплату вручную в карточке заказа.`,
        });
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    }
  };

  const submitEdit = async () => {
    if (!editing) return;
    setError(null);
    const collected = collectItems();
    if (!collected.ok) {
      setItemErrors(collected.errors);
      setError('Исправьте выделенные позиции — они не будут сохранены в таком виде');
      return;
    }
    const cleaned = collected.items;
    if (!cleaned.length) {
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
    <>
    <Sheet open={open} onOpenChange={(o) => !o && requestClose()}>
      <SheetContent side="right" hideClose size="2xl">
        <SheetHeader className="flex-row items-center justify-between gap-2 space-y-0">
          <SheetTitle>{isEdit ? `Изменить ${editing?.number ?? 'заказ'}` : 'Новый заказ'}</SheetTitle>
          <Button variant="ghost" size="icon" onClick={requestClose} aria-label="Закрыть">
            <X className="h-4 w-4" />
          </Button>
        </SheetHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void (isEdit ? submitEdit() : submitCreate());
          }}
        >
        <SheetBody className="space-y-4">
          <FormField label="Клиент" htmlFor="o-client">
            <Combobox
              id="o-client"
              value={clientId}
              onChange={setClientId}
              options={(clients.data ?? []).map((c) => ({
                value: c.id,
                label: c.name,
                description: c.contact ?? undefined,
              }))}
              placeholder="— Без клиента —"
              searchPlaceholder="Имя или контакт…"
              clearLabel="— Без клиента —"
              recentKey={`${wsId}:client`}
              onCreate={(q) => setCreateClientQuery(q)}
              createLabel={(q) => `Создать клиента «${q}»`}
            />
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
            {/* Постоянные заголовки колонок числовой строки — вместо угадывания
                по плейсхолдерам. Скрыты на узком экране (там подписи в placeholder). */}
            <div className="hidden items-center gap-2 px-3 text-xs font-medium uppercase text-muted-foreground sm:flex">
              <div className="flex-1">Наименование</div>
              <div className="w-16">Кол-во</div>
              <div className="w-24">Цена прод.</div>
              <div className="w-24">Закуп. цена</div>
              <div className="w-24 text-right">Сумма</div>
            </div>
            {items.map((it, i) => {
              const wh = warehouse.data?.find((w) => w.id === it.warehouseItemId);
              const rowError = itemErrors[i];
              const lineSum = mul(parseDraft(it.qty), parseDraft(it.unitPrice));
              return (
                <div
                  key={i}
                  className={cn(
                    'space-y-1.5 rounded-md border p-2.5',
                    rowError ? 'border-destructive' : 'border-border',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <Combobox
                      value={it.warehouseItemId ?? ''}
                      onChange={(v) => {
                        const item = warehouse.data?.find((w) => w.id === v);
                        patchItem(i, {
                          warehouseItemId: v || null,
                          ...(item ? { name: item.name } : {}),
                        });
                      }}
                      options={skuOptions}
                      placeholder="Услуга / без склада"
                      searchPlaceholder="Название, цвет или артикул…"
                      clearLabel="Услуга / без склада"
                      recentKey={`${wsId}:sku`}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        setItems((arr) => arr.filter((_, j) => j !== i));
                        setItemErrors({});
                      }}
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
                        onChange={(e) => patchItem(i, { name: e.target.value })}
                        placeholder="Наименование"
                        aria-invalid={rowError ? true : undefined}
                      />
                    </div>
                    <div className="w-16">
                      <Input
                        inputMode="decimal"
                        value={it.qty}
                        onChange={(e) => patchItem(i, { qty: e.target.value })}
                        placeholder="Кол."
                        aria-invalid={rowError ? true : undefined}
                      />
                    </div>
                    <div className="w-24">
                      <Input
                        inputMode="decimal"
                        value={it.unitPrice}
                        onChange={(e) => patchItem(i, { unitPrice: e.target.value })}
                        placeholder="Цена прод."
                        aria-invalid={rowError ? true : undefined}
                      />
                    </div>
                    <div className="w-24">
                      <Input
                        inputMode="decimal"
                        value={it.unitCost ?? ''}
                        onChange={(e) => patchItem(i, { unitCost: e.target.value })}
                        placeholder="Закуп. цена"
                        aria-invalid={rowError ? true : undefined}
                      />
                    </div>
                    {/* Сумма строки qty×цена — только чтение, видно вклад позиции. */}
                    <div className="flex h-10 w-24 items-center justify-end text-sm tabular-nums sm:h-9">
                      {lineSum.gt(0) ? formatRub(toMoneyString(lineSum)) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </div>
                  </div>
                  {rowError && (
                    <p role="alert" className="text-xs font-medium text-destructive">
                      {rowError}
                    </p>
                  )}
                  {wh && !it.unitCost && (
                    <p className="text-xs text-muted-foreground">
                      Себестоимость со склада {formatRub(wh.avgCost)} · спишется при
                      закрытии. Или впишите закупочную цену вручную.
                    </p>
                  )}
                  {!it.warehouseItemId && it.unitCost && (
                    <p className="text-xs text-amber-600">
                      Эта сумма уже попадёт в прибыль как себестоимость при закрытии заказа.
                      Не заводите её повторно отдельной расходной операцией — будет двойной учёт.
                    </p>
                  )}
                </div>
              );
            })}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
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
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setPasteOpen((v) => !v)}
                aria-expanded={pasteOpen}
              >
                <ClipboardList className="h-3.5 w-3.5" /> Вставить составом
              </Button>
            </div>

            {pasteOpen && (
              <div className="space-y-2 rounded-md border border-border bg-secondary/30 p-3">
                <p className="text-xs text-muted-foreground">
                  Строка на позицию: <span className="font-medium">название / закупка / цена продажи</span>.
                  Закупка и цена необязательны, разделители — «/», «|» или табуляция (вставка из
                  таблицы). Количество — хвостом названия: «Вентилятор 120мм ×4».
                </p>
                <Textarea
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
                  placeholder={'Процессор AMD Ryzen 7 9800X3D / 33202\nВидеокарта Palit RTX 5080 / 124999'}
                  rows={6}
                />
                {pasteText.trim() && (
                  <div className="space-y-1 text-xs">
                    <p className={pasteParsed.items.length ? 'text-success' : 'text-muted-foreground'}>
                      Распознано позиций: {pasteParsed.items.length}
                    </p>
                    {pasteParsed.errors.map((e) => (
                      <p key={e.line} className="text-destructive">
                        Строка {e.line}: {e.reason} — «{e.text}»
                      </p>
                    ))}
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => applyPaste('replace')}
                    disabled={!pasteParsed.items.length}
                  >
                    Заменить позиции
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => applyPaste('append')}
                    disabled={!pasteParsed.items.length}
                  >
                    Добавить к текущим
                  </Button>
                </div>
              </div>
            )}

            {/* Клиент платит одну сумму за сборку — цены по позициям выводятся из
                неё пропорционально закупке, как считали в калькуляторе вручную. */}
            <div className="flex flex-wrap items-end gap-2 rounded-md border border-border p-3">
              <label className="flex flex-1 flex-col gap-1 text-xs text-muted-foreground">
                <span>Итог заказа для распределения</span>
                <Input
                  inputMode="decimal"
                  value={allocTotal}
                  onChange={(e) => setAllocTotal(e.target.value)}
                  placeholder="напр. 461468"
                />
              </label>
              <Button type="button" variant="secondary" size="sm" onClick={applyAllocation}>
                Распределить цену продажи
              </Button>
            </div>
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
                <span>Валовая прибыль (план)</span>
                <span className="tabular-nums">
                  {costIsEstimate ? '≈ ' : ''}
                  {formatRub(toMoneyString(estEarnings))}
                </span>
              </div>
            )}
          </div>

          {/* План оплаты — только при создании. В правке платежи/график живут
              в карточке заказа (вкладка «Оплата»). */}
          {!isEdit && (
            <div className="space-y-3">
              <div className="text-sm font-medium">Оплата</div>
              <div className="flex flex-wrap gap-2">
                {(
                  [
                    ['none', 'Без оплаты'],
                    ['full', 'Оплата сразу 100%'],
                    ['schedule', 'Свой график'],
                  ] as const
                ).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => {
                      setPayMode(mode);
                      setPayError(null);
                      // При переходе в «Свой график» — одна пустая строка остатка.
                      if (mode === 'schedule' && scheduleRows.length === 0) {
                        setScheduleRows([{ dueDate: '', amount: '' }]);
                      }
                    }}
                    className={cn(
                      'rounded-full border px-3 py-1.5 text-sm font-medium transition-colors',
                      payMode === mode
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-input bg-background text-foreground hover:bg-secondary',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {payMode === 'full' && (
                <div className="space-y-1.5">
                  <FormField label="Счёт зачисления" htmlFor="o-pay-full" required>
                    <Combobox
                      id="o-pay-full"
                      value={payAccountFull}
                      onChange={setPayAccountFull}
                      options={accountOptions}
                      placeholder="— Счёт —"
                      searchPlaceholder="Счёт…"
                    />
                  </FormField>
                  <p className="text-xs text-muted-foreground">
                    Запишем платёж на всю сумму {formatRub(toMoneyString(total))} сегодня.
                  </p>
                </div>
              )}

              {payMode === 'schedule' && (
                <div className="space-y-3 rounded-md border border-border p-3">
                  <div className="space-y-1.5">
                    <div className="text-sm font-medium">
                      Предоплата сейчас (если получена)
                    </div>
                    <div className="flex items-end gap-2">
                      <div className="w-32">
                        <Input
                          inputMode="decimal"
                          value={prepayAmount}
                          onChange={(e) => setPrepayAmount(e.target.value)}
                          placeholder="Сумма, ₽"
                          aria-label="Сумма предоплаты"
                        />
                      </div>
                      <div className="flex-1">
                        <Combobox
                          value={prepayAccount}
                          onChange={setPrepayAccount}
                          options={accountOptions}
                          placeholder="— Счёт —"
                          searchPlaceholder="Счёт…"
                        />
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Реальный платёж сегодня. Оставьте пустым, если предоплаты нет.
                    </p>
                  </div>

                  <div className="space-y-1.5">
                    <div className="text-sm font-medium">
                      Остаток по датам
                    </div>
                    {scheduleRows.map((r, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <Input
                          type="date"
                          value={r.dueDate}
                          onChange={(e) =>
                            setScheduleRows((arr) =>
                              arr.map((x, j) => (j === i ? { ...x, dueDate: e.target.value } : x)),
                            )
                          }
                          className="w-[150px]"
                        />
                        <Input
                          inputMode="decimal"
                          value={r.amount}
                          onChange={(e) =>
                            setScheduleRows((arr) =>
                              arr.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)),
                            )
                          }
                          placeholder="Сумма, ₽"
                          className="flex-1"
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() =>
                            setScheduleRows((arr) => arr.filter((_, j) => j !== i))
                          }
                          aria-label="Удалить строку"
                          disabled={scheduleRows.length === 1}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setScheduleRows((arr) => [...arr, { dueDate: '', amount: '' }])
                      }
                    >
                      <Plus className="h-3.5 w-3.5" /> Дата
                    </Button>
                  </div>

                  {/* Σ плана vs итог — предупреждение, а не блокировка. */}
                  <div className="flex justify-between border-t border-border pt-2 text-sm">
                    <span className="text-muted-foreground">План (предоплата + остаток)</span>
                    <span className={cn('tabular-nums', !planMatchesTotal && 'text-amber-600')}>
                      {formatRub(toMoneyString(planTotal))} из {formatRub(toMoneyString(total))}
                    </span>
                  </div>
                  {!planMatchesTotal && planTotal.gt(0) && (
                    <p className="text-xs text-amber-600">
                      План не сходится с итогом заказа — проверьте суммы (можно сохранить как есть).
                    </p>
                  )}
                </div>
              )}

              {payError && <p className="text-sm text-destructive">{payError}</p>}
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
        </SheetBody>
        <SheetFooter>
          {isEdit ? (
            <>
              <Button
                type="button"
                variant="secondary"
                onClick={requestClose}
                disabled={update.isPending}
              >
                Отмена
              </Button>
              <Button type="submit" loading={update.isPending}>
                Сохранить
              </Button>
            </>
          ) : (
            <Button
              type="submit"
              loading={create.isPending || setSchedule.isPending || addPayment.isPending}
            >
              Создать заказ
            </Button>
          )}
        </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
    <ConfirmDialog
      open={confirmClose}
      onOpenChange={setConfirmClose}
      title="Закрыть без сохранения?"
      description="В форме заказа есть несохранённые изменения — они будут потеряны."
      confirmText="Закрыть"
      cancelText="Вернуться к форме"
      onConfirm={() => {
        setConfirmClose(false);
        onClose();
      }}
    />
    <QuickCreateCounterpartyDialog
      wsId={wsId}
      role="CLIENT"
      open={createClientQuery !== null}
      initialName={createClientQuery ?? ''}
      onOpenChange={(o) => !o && setCreateClientQuery(null)}
      onCreated={setClientId}
    />
    </>
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
  const { data: trace, isLoading: traceLoading } = useOrderTrace(wsId, orderId);
  const accounts = useAccounts(wsId);
  const addPayment = useAddOrderPayment(wsId);
  const addInstallment = useAddInstallmentPayment(wsId);
  const deletePayment = useDeleteOrderPayment(wsId);
  const finalize = useFinalizeOrder(wsId);
  const cancel = useCancelOrder(wsId);
  const reopen = useReopenOrder(wsId);
  // Дата отгрузки спрашивается при закрытии: по ней признаётся выручка и
  // датируется себестоимость. Для заказа, который заносят задним числом,
  // «сегодня» увело бы обе суммы в текущий месяц.
  const [closeOpen, setCloseOpen] = useState(false);
  const [closeDate, setCloseDate] = useState(() => toLocalDateInput(new Date()));
  const uploadAtt = useUploadOrderAttachment(wsId);
  const deleteAtt = useDeleteOrderAttachment(wsId);

  const [payAmount, setPayAmount] = useState('');
  // Дата оплаты: архивы заносятся задним числом, и без этого поля платёж вставал
  // сегодняшним днём — расход месяца уезжал, а остаток счёта переставал сходиться
  // с выпиской. Пусто = сегодня (обычный сценарий «принял деньги сейчас»).
  const [payDate, setPayDate] = useState('');
  const [payAccount, setPayAccount] = useState('');
  const [payInstallment, setPayInstallment] = useState(false);
  const [payFee, setPayFee] = useState('');
  // Панель подбора строки выписки под этот заказ — раскрывается по кнопке.
  const [findPayment, setFindPayment] = useState(false);
  // Кандидаты считаются под конкретный остаток: при переходе к другому заказу
  // раскрытая панель показывала бы подсказки от предыдущего.
  useEffect(() => setFindPayment(false), [orderId]);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmDeleteAtt, setConfirmDeleteAtt] = useState<string | null>(null);
  const [confirmDeletePayment, setConfirmDeletePayment] = useState<string | null>(null);
  const [editSchedule, setEditSchedule] = useState(false);
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
      if (payInstallment) {
        // F3: рассрочка gross — полная сумма выручкой + комиссия банка расходом.
        const fee = parseAmountInput(payFee || '0');
        if (fee === null) {
          setError('Некорректная комиссия');
          return;
        }
        await addInstallment.mutateAsync({
          id: orderId,
          amount,
          fee,
          accountId: payAccount,
          ...(payDate ? { date: fromLocalDateInput(payDate) } : {}),
        });
        toast.success('Рассрочка оформлена', {
          description: `Выручка ${formatRub(amount)}, комиссия ${formatRub(fee)}`,
        });
      } else {
        await addPayment.mutateAsync({
          id: orderId,
          amount,
          accountId: payAccount,
          ...(payDate ? { date: fromLocalDateInput(payDate) } : {}),
        });
        toast.success('Оплата добавлена');
      }
      setPayAmount('');
      setPayFee('');
      setPayDate('');
      setPayInstallment(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    }
  };

  return (
    <>
      <Sheet open={!!orderId} onOpenChange={(o) => !o && onClose()}>
        <SheetContent side="right" hideClose size="2xl">
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
                  <StatusStamp
                    tone={STATUS_TONE[order.status]}
                    label={STATUS_LABEL[order.status]}
                  />
                  <StatusStamp
                    tone={PAY_TONE[order.paymentStatus]}
                    label={PAY_LABEL[order.paymentStatus]}
                  />
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

                <Tabs defaultValue="overview">
                  <TabsList className="flex w-full">
                    <TabsTrigger value="overview">Обзор</TabsTrigger>
                    <TabsTrigger value="payment">Оплата</TabsTrigger>
                    <TabsTrigger value="stock">Склад</TabsTrigger>
                    <TabsTrigger value="docs">Документы</TabsTrigger>
                  </TabsList>

                  {/* ─────────────── Обзор: позиции + итоги + маржа ─────────────── */}
                  <TabsContent value="overview" className="space-y-5">
                {/* Items: строка читается как «закупка → продажа → маржа».
                    Закупка за единицу — эффективная себестоимость с бэкенда
                    (каскад BR1: факт FIFO → ручной ввод → оценка по складу). */}
                <div className="overflow-x-auto rounded-md border border-border">
                  <table className="w-full text-base">
                    <thead className="border-b border-border bg-secondary/40">
                      <tr className="text-left text-xs uppercase text-muted-foreground">
                        <th className="px-3 py-2 font-medium">Позиция</th>
                        <th className="px-3 py-2 text-right font-medium">Кол-во</th>
                        <th className="px-3 py-2 text-right font-medium">Закупка</th>
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
                          {/* «≈» — себестоимость пока оценка по складу (до выдачи). */}
                          <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                            {it.margin?.unitCost ? (
                              <>
                                {it.margin.costSource === 'estimate' && '≈ '}
                                {formatRub(it.margin.unitCost)}
                              </>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {formatRub(it.unitPrice)}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {formatRub(it.lineTotal)}
                          </td>
                          {/* Маржа строки — с бэкенда (netQty за вычетом возвратов). */}
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

                  </TabsContent>

                  {/* ─────────────── Оплата: принять + график + журнал ─────────────── */}
                  <TabsContent value="payment" className="space-y-5">
                {/* Деньги за заказ обычно уже лежат во «Входящих» — искать их там
                    руками среди сотен строк и было главным тупиком (P0.2). */}
                {order.status !== 'CANCELLED' && order.paymentStatus !== 'PAID' && (
                  findPayment ? (
                    <FindPaymentPanel
                      wsId={wsId}
                      order={order}
                      onClose={() => setFindPayment(false)}
                    />
                  ) : (
                    <Button variant="secondary" size="sm" onClick={() => setFindPayment(true)}>
                      Найти оплату во «Входящих»
                    </Button>
                  )
                )}

                {/* Принять оплату — закреплено вверху вкладки, без прокрутки 10 секций */}
                {order.status !== 'CANCELLED' && (
                  <div className="space-y-2 rounded-md border border-border p-3">
                    <div className="text-sm font-medium">Принять оплату</div>
                    <div className="flex items-end gap-2">
                      <div className="w-32">
                        <Input
                          inputMode="decimal"
                          value={payAmount}
                          onChange={(e) => setPayAmount(e.target.value)}
                          placeholder={payInstallment ? 'Полная сумма' : 'Сумма'}
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
                      <div className="w-40">
                        <Input
                          type="date"
                          value={payDate}
                          max={toLocalDateInput(new Date())}
                          onChange={(e) => setPayDate(e.target.value)}
                          title="Дата оплаты — пусто означает сегодня"
                        />
                      </div>
                      <Button
                        onClick={onPay}
                        loading={addPayment.isPending || addInstallment.isPending}
                      >
                        Добавить
                      </Button>
                    </div>
                    {/* F3: сторонняя рассрочка — gross. Полная сумма выручкой
                        закрывает дебиторку, комиссия банка отдельным расходом. */}
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={payInstallment}
                        onChange={(e) => setPayInstallment(e.target.checked)}
                        className="h-4 w-4 rounded border-input accent-primary"
                      />
                      Рассрочка (сторонняя)
                    </label>
                    {payInstallment && (
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <div className="w-32">
                            <Input
                              inputMode="decimal"
                              value={payFee}
                              onChange={(e) => setPayFee(e.target.value)}
                              placeholder="Комиссия, ₽"
                              aria-label="Комиссия банка рассрочки"
                            />
                          </div>
                          <span className="text-xs text-muted-foreground">
                            {(() => {
                              const a = parseAmountInput(payAmount || '');
                              const f = parseAmountInput(payFee || '0');
                              if (!a || f === null) return 'комиссия банка из договора';
                              return `на счёт поступит ${formatRub(toMoneyString(sub(a, f)))}`;
                            })()}
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          В выручку пойдёт полная сумма, комиссия — отдельным расходом по заказу.
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {/* График платежей (F2): план «суммы + даты», покрытие строк
                    считает бэкенд FIFO из paidAmount — здесь только рисуем. */}
                <div>
                  <div className="mb-1.5 flex items-center justify-between">
                    <div className="text-xs font-medium uppercase text-muted-foreground">
                      График платежей
                    </div>
                    {order.status !== 'CANCELLED' && (
                      <Button variant="ghost" size="sm" onClick={() => setEditSchedule(true)}>
                        {order.schedule ? 'Изменить' : 'Задать'}
                      </Button>
                    )}
                  </div>
                  {order.schedule ? (
                    <div className="space-y-1.5">
                      {!order.schedule.summary.matchesTotal && (
                        <p className="text-xs text-amber-600">
                          Сумма графика {formatRub(order.schedule.summary.planned)} не сходится
                          с итогом заказа {formatRub(order.totalAmount)}.
                        </p>
                      )}
                      <div className="overflow-hidden rounded-md border border-border">
                        <table className="w-full text-base">
                          <tbody>
                            {order.schedule.entries.map((e) => (
                              <tr key={e.id} className="border-b border-border last:border-0">
                                <td className="px-3 py-1.5 tabular-nums">
                                  {formatDate(e.dueDate)}
                                  {e.note && (
                                    <div className="text-xs text-muted-foreground">{e.note}</div>
                                  )}
                                </td>
                                <td className="px-3 py-1.5 text-right tabular-nums">
                                  {formatRub(e.amount)}
                                  {e.status !== 'PAID' && e.covered !== '0.00' && (
                                    <div className="text-xs text-muted-foreground">
                                      осталось {formatRub(e.remaining)}
                                    </div>
                                  )}
                                </td>
                                <td className="w-[110px] px-3 py-1.5 text-right">
                                  <Badge variant={SCHED_VARIANT[e.status]}>
                                    {SCHED_LABEL[e.status]}
                                  </Badge>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <div className="space-y-1 text-sm">
                        {order.schedule.summary.overdueAmount !== '0.00' && (
                          <Row
                            label="Просрочено"
                            value={formatRub(order.schedule.summary.overdueAmount)}
                            tone="neg"
                            strong
                          />
                        )}
                        {order.schedule.summary.nextDueDate && (
                          <Row
                            label="Следующий платёж"
                            value={`${formatDate(order.schedule.summary.nextDueDate)} · ${formatRub(order.schedule.summary.nextDueAmount ?? '0')}`}
                          />
                        )}
                      </div>
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Не задан — оплата в свободном порядке.
                    </p>
                  )}
                </div>

                {/* Payments log */}
                {order.transactions && order.transactions.length > 0 && (
                  <div>
                    <div className="mb-1.5 text-sm font-semibold">
                      Платежи
                    </div>
                    <div className="space-y-1">
                      {/* Подпись и знак — по kind/type: помимо оплат тут живут
                          возвраты, комиссия рассрочки (F3) и COGS услуг. */}
                      {order.transactions.map((t) => {
                        const label =
                          t.kind === 'ORDER_REFUND'
                            ? 'возврат'
                            : t.kind === 'VARIABLE_COST'
                              ? 'комиссия рассрочки'
                              : t.kind === 'COGS'
                                ? 'себестоимость'
                                : 'оплата';
                        const negative = t.type === 'EXPENSE';
                        // C2: удаляемы ровно те kind, что разрешает бэкенд
                        // (DELETABLE_PAYMENT_KINDS) — платёж/возврат/комиссия;
                        // себестоимость (COGS) управляется отменой заказа.
                        // Разрешено на любом статусе (коррекция ошибки).
                        const deletable =
                          t.kind === 'ORDER_PAYMENT' ||
                          t.kind === 'ORDER_REFUND' ||
                          t.kind === 'VARIABLE_COST';
                        return (
                          <div
                            key={t.id}
                            className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-1.5 text-sm"
                          >
                            <span className="text-muted-foreground">
                              {formatDate(t.date)} · {label}
                            </span>
                            <div className="flex items-center gap-2">
                              <span
                                className={cn(
                                  'tabular-nums',
                                  negative ? 'text-destructive' : 'text-success',
                                )}
                              >
                                {negative ? '−' : '+'}
                                {formatRub(t.amount)}
                              </span>
                              {deletable && (
                                <button
                                  type="button"
                                  onClick={() => setConfirmDeletePayment(t.id)}
                                  aria-label="Удалить операцию"
                                  className="text-muted-foreground transition-colors hover:text-destructive"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                  </TabsContent>

                  {/* ─────────────── Склад: происхождение партий (F5) ─────────────── */}
                  <TabsContent value="stock" className="space-y-5">
                {trace && trace.items.length > 0 ? (
                  <div>
                    <div className="mb-1.5 text-sm font-semibold">
                      Происхождение (партии)
                    </div>
                    <div className="space-y-1.5">
                      {trace.items.map((ti) => {
                        const line = (order.items ?? []).find((i) => i.id === ti.orderItemId);
                        return (
                          <div
                            key={ti.orderItemId}
                            className="rounded-md border border-border px-3 py-2 text-sm"
                          >
                            <div className="font-medium">{line?.name ?? 'Позиция'}</div>
                            {ti.lots.map((l) => (
                              <div
                                key={l.lotId}
                                className="text-xs text-muted-foreground tabular-nums"
                              >
                                {l.qty} × {formatRub(l.unitCost)} · от{' '}
                                {formatDate(l.receivedAt)}
                                {l.supplier ? ` · ${l.supplier.name}` : ''}
                                {l.account ? ` · ${l.account.name}` : ''}
                              </div>
                            ))}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : traceLoading ? (
                  <p className="text-sm text-muted-foreground">Загрузка…</p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Партии появятся после закрытия заказа — склад спишется по ФИФО при выдаче.
                  </p>
                )}
                  </TabsContent>

                  {/* ─────────────── Документы: чеки ─────────────── */}
                  <TabsContent value="docs" className="space-y-5">
                <div>
                  <div className="mb-1.5 text-sm font-semibold">
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
                      {uploadAtt.isPending ? 'Загрузка…' : 'Прикрепить чек'}
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
                  </TabsContent>
                </Tabs>

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
                  {reopen.isPending ? 'Возвращаем в работу…' : 'Вернуть в работу'}
                </Button>
              ) : (
                <>
                  <Button variant="secondary" onClick={() => onEdit(order)}>
                    Изменить
                  </Button>
                  <Button
                    onClick={() => {
                      setCloseDate(toLocalDateInput(new Date()));
                      setCloseOpen(true);
                    }}
                    disabled={finalize.isPending}
                  >
                    {finalize.isPending ? 'Закрытие…' : 'Закрыть заказ'}
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
                {reopen.isPending ? 'Возвращаем в работу…' : 'Вернуть в работу'}
              </Button>
            </SheetFooter>
          )}
        </SheetContent>
      </Sheet>

      <ConfirmDialog
        open={closeOpen}
        onOpenChange={setCloseOpen}
        title="Закрыть заказ"
        // Не destructive: закрытие — штатный шаг, а не опасное действие.
        variant="primary"
        confirmText="Закрыть заказ"
        description={
          <div className="space-y-3">
            <p>
              Выручка и себестоимость будут признаны на эту дату — ставьте день
              отгрузки, а не сегодняшний, если заказ вносится задним числом.
            </p>
            <FormField label="Дата отгрузки" htmlFor="order-close-date" required>
              <Input
                id="order-close-date"
                type="date"
                value={closeDate}
                max={toLocalDateInput(new Date())}
                onChange={(e) => setCloseDate(e.target.value)}
              />
            </FormField>
          </div>
        }
        onConfirm={async () => {
          if (!order || !closeDate) return;
          await finalize.mutateAsync({
            id: order.id,
            closedOn: fromLocalDateInput(closeDate),
          });
          setCloseOpen(false);
        }}
        loading={finalize.isPending}
      />

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

      <ConfirmDialog
        open={confirmDeletePayment !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDeletePayment(null);
        }}
        title="Удалить операцию?"
        description="Ошибочный платёж/возврат/комиссия будет удалён, оплата по заказу пересчитается. Если деньги фактически вернули клиенту — оформите отдельную расходную операцию."
        confirmText="Удалить"
        onConfirm={async () => {
          if (order && confirmDeletePayment) {
            await deletePayment.mutateAsync({ id: order.id, txId: confirmDeletePayment });
          }
          setConfirmDeletePayment(null);
        }}
        loading={deletePayment.isPending}
      />

      {order && (
        <ScheduleDialog
          wsId={wsId}
          order={order}
          open={editSchedule}
          onClose={() => setEditSchedule(false)}
        />
      )}
    </>
  );
}

// ─────────────────────────── Schedule editor (F2) ───────────────────────────

interface ScheduleRowDraft {
  dueDate: string; // yyyy-mm-dd
  amount: string;
  note: string;
}

function ScheduleDialog({
  wsId,
  order,
  open,
  onClose,
}: {
  wsId: string;
  order: Order;
  open: boolean;
  onClose: () => void;
}) {
  const setSchedule = useSetOrderSchedule(wsId);
  const [rows, setRows] = useState<ScheduleRowDraft[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setRows(
      order.schedule?.entries.map((e) => ({
        dueDate: e.dueDate.slice(0, 10),
        amount: e.amount,
        note: e.note ?? '',
      })) ?? [{ dueDate: new Date().toISOString().slice(0, 10), amount: '', note: '' }],
    );
    setError(null);
  }, [open, order]);

  // Σ-превью черновика через Decimal (введённое сравнивается с итогом заказа).
  const planned = rows.reduce((acc, r) => {
    const p = r.amount ? parseAmountInput(r.amount) : null;
    return p ? add(acc, p) : acc;
  }, D(0));
  const matches = planned.eq(D(order.totalAmount));

  const collect = (): { dueDate: string; amount: string; note?: string }[] | null => {
    const entries: { dueDate: string; amount: string; note?: string }[] = [];
    for (const r of rows) {
      if (!r.dueDate && !r.amount) continue; // полностью пустую строку молча пропускаем
      const amount = parseAmountInput(r.amount);
      if (!r.dueDate || !amount || D(amount).lte(0)) {
        setError('В каждой строке нужны дата и положительная сумма');
        return null;
      }
      entries.push({
        dueDate: new Date(r.dueDate).toISOString(),
        amount,
        note: r.note.trim() || undefined,
      });
    }
    return entries;
  };

  const save = async () => {
    setError(null);
    const entries = collect();
    if (!entries) return;
    try {
      await setSchedule.mutateAsync({ id: order.id, entries });
      toast.success(entries.length ? 'График сохранён' : 'График убран');
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    }
  };

  const clear = async () => {
    setError(null);
    try {
      await setSchedule.mutateAsync({ id: order.id, entries: [] });
      toast.success('График убран');
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>График платежей · {order.number}</DialogTitle>
        </DialogHeader>

        <div className="space-y-2">
          {rows.map((r, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                type="date"
                value={r.dueDate}
                onChange={(e) =>
                  setRows((arr) =>
                    arr.map((x, j) => (j === i ? { ...x, dueDate: e.target.value } : x)),
                  )
                }
                className="w-[150px]"
              />
              <Input
                inputMode="decimal"
                placeholder="Сумма"
                value={r.amount}
                onChange={(e) =>
                  setRows((arr) =>
                    arr.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)),
                  )
                }
                className="w-[120px]"
              />
              <Input
                placeholder="Заметка"
                value={r.note}
                onChange={(e) =>
                  setRows((arr) =>
                    arr.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)),
                  )
                }
                className="flex-1"
              />
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setRows((arr) => arr.filter((_, j) => j !== i))}
                aria-label="Удалить строку"
                disabled={rows.length === 1}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              setRows((arr) => [
                ...arr,
                { dueDate: new Date().toISOString().slice(0, 10), amount: '', note: '' },
              ])
            }
          >
            <Plus className="h-3.5 w-3.5" /> Платёж
          </Button>

          <div className="space-y-1 rounded-md border border-border bg-secondary/40 p-3 text-sm">
            <Row label="Сумма графика" value={formatRub(toMoneyString(planned))} />
            <Row label="Итог заказа" value={formatRub(order.totalAmount)} />
            {!matches && planned.gt(0) && (
              <p className="text-xs text-amber-600">
                Суммы не сходятся — график сохранится, но карточка будет предупреждать.
              </p>
            )}
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          {order.schedule && (
            <Button
              variant="ghost"
              className="text-destructive sm:mr-auto"
              onClick={clear}
              disabled={setSchedule.isPending}
            >
              Убрать график
            </Button>
          )}
          <Button variant="secondary" onClick={onClose} disabled={setSchedule.isPending}>
            Отмена
          </Button>
          <Button onClick={save} disabled={setSchedule.isPending}>
            {setSchedule.isPending ? 'Сохранение…' : 'Сохранить'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  tone?: 'pos' | 'neg';
}) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={cn(
          'tabular-nums',
          strong && 'font-semibold',
          tone === 'pos' && 'text-success',
          tone === 'neg' && 'text-destructive',
        )}
      >
        {value}
      </span>
    </div>
  );
}
