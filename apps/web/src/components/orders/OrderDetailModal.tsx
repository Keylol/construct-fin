'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { FindPaymentPanel } from '@/components/orders/FindPaymentPanel';
import { ScheduleModal } from '@/components/orders/ScheduleModal';
import { PAY_LABEL, PAY_TONE, Row, SCHED_LABEL, SCHED_VARIANT, STATUS_LABEL, STATUS_TONE } from '@/components/orders/order-shared';
import { Badge } from '@/components/ui/Badge';
import { Money } from '@/components/ui/Money';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, ModalTitle } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { StatusStamp } from '@/components/ui/StatusStamp';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import { toast } from '@/components/ui/Toaster';
import { Paperclip, Receipt, Trash2, X } from '@/components/ui/icons';
import { useAccounts } from '@/hooks/useAccounts';
import { useAddInstallmentPayment, useAddOrderPayment, useCancelOrder, useDeleteOrder, useDeleteOrderAttachment, useDeleteOrderPayment, useFinalizeOrder, useOrder, useOrderTrace, useReopenOrder, useUploadOrderAttachment } from '@/hooks/useOrders';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/dates';
import { fromLocalDateInput, toLocalDateInput } from '@/lib/periods';
import type { Order } from '@/lib/types';
import { D, formatRub, parseAmountInput, sub, toMoneyString } from '@construct/shared';

export function OrderDetailModal({
  wsId,
  orderId,
  onClose,
  onEdit,
  autoClose = false,
}: {
  wsId: string;
  orderId: string | null;
  onClose: () => void;
  onEdit: (order: Order) => void;
  /** Карточка открыта кликом по «можно закрыть» — сразу показать диалог. */
  autoClose?: boolean;
}) {
  const router = useRouter();
  const { data: order, isLoading } = useOrder(wsId, orderId);
  const { data: trace, isLoading: traceLoading } = useOrderTrace(wsId, orderId);
  const accounts = useAccounts(wsId);
  const addPayment = useAddOrderPayment(wsId);
  const addInstallment = useAddInstallmentPayment(wsId);
  const deletePayment = useDeleteOrderPayment(wsId);
  const finalize = useFinalizeOrder(wsId);
  const cancel = useCancelOrder(wsId);
  const reopen = useReopenOrder(wsId);
  const removeOrder = useDeleteOrder(wsId);
  // Дата отгрузки спрашивается при закрытии: по ней признаётся выручка и
  // датируется себестоимость. Для заказа, который заносят задним числом,
  // «сегодня» увело бы обе суммы в текущий месяц.
  const [closeOpen, setCloseOpen] = useState(false);
  const [closeDate, setCloseDate] = useState(() => toLocalDateInput(new Date()));
  // Правило закрытия — по дате денег: выручка признаётся днём последней оплаты,
  // а не днём, когда до заказа дошли руки. Со «сегодня» по умолчанию прибыль
  // архива уезжала в текущий месяц (та же боль дала поле даты в #135).
  const payments = useMemo(
    () => (order?.transactions ?? []).filter((t) => t.kind === 'ORDER_PAYMENT'),
    [order?.transactions],
  );
  const lastPaymentDate = useMemo(() => {
    const dates = payments.map((t) => t.date);
    return dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : null;
  }, [payments]);
  const loadedId = order?.id ?? null;
  useEffect(() => {
    setCloseDate(toLocalDateInput(lastPaymentDate ?? new Date()));
  }, [lastPaymentDate, loadedId]);
  // Клик по «можно закрыть» в списке ведёт прямо в диалог: дату и подтверждение
  // он всё равно спрашивает, случайного закрытия не будет.
  useEffect(() => {
    if (autoClose && loadedId) setCloseOpen(true);
  }, [autoClose, loadedId]);
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
  // Удаление заказа — не то же самое, что отмена: отменённый остаётся в истории,
  // удалённый исчезает вместе с оплатами и чеками. Нужен для заказов, заведённых
  // по ошибке (тестовые, дубли архива), которые иначе висят в списке навсегда.
  const [confirmDelete, setConfirmDelete] = useState(false);
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
      <Modal open={!!orderId} onOpenChange={(o) => !o && onClose()}>
        <ModalContent hideClose size="2xl">
          <ModalHeader className="flex-row items-center justify-between gap-2 space-y-0">
            <ModalTitle>{order ? order.number : 'Заказ'}</ModalTitle>
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="Закрыть">
              <X className="h-4 w-4" />
            </Button>
          </ModalHeader>

          <ModalBody className="space-y-5">
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
                                <Money value={it.margin.unitCost} tone="plain" />
                              </>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td className="px-3 py-2 text-right"><Money value={it.unitPrice} /></td>
                          <td className="px-3 py-2 text-right"><Money value={it.lineTotal} /></td>
                          {/* Маржа строки — с бэкенда (netQty за вычетом возвратов). */}
                          <td className="px-3 py-2 text-right tabular-nums">
                            {it.margin ? (
                              <>
                                <div>
                                  {it.margin.costSource === 'estimate' && '≈ '}
                                  <Money value={it.margin.margin} />
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
                  <Row label="Сумма позиций" value={<Money value={order.subtotal} />} />
                  {D(order.discountAmount).gt(0) && (
                    <Row label="Скидка" value={<>−<Money value={order.discountAmount} /></>} />
                  )}
                  <Row label="Итого" value={<Money value={order.totalAmount} />} strong />
                  <Row
                    label="Оплачено"
                    value={<Money value={order.paidAmount} tone="plain" />}
                    tone={D(order.paidAmount).gte(order.totalAmount) ? 'pos' : undefined}
                  />
                  <Row
                    label="Остаток"
                    value={
                      <Money
                        value={toMoneyString(
                          (() => {
                            const due = sub(order.totalAmount, order.paidAmount);
                            return due.gt(0) ? due : D(0);
                          })(),
                        )}
                      />
                    }
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
                        value={<Money value={order.margin.revenue} tone="plain" />}
                        tone="pos"
                      />
                      <Row
                        label={
                          order.margin.isEstimate
                            ? 'Расход (себестоимость, оценка по складу)'
                            : 'Расход (себестоимость)'
                        }
                        value={<Money value={order.margin.cogs} />}
                      />
                      <Row
                        label="Прибыль"
                        value={
                          <>
                            {order.margin.isEstimate ? '≈ ' : ''}
                            <Money value={order.margin.margin} tone="plain" /> ·{' '}
                            {order.margin.marginPct}%
                          </>
                        }
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
                                  <Money value={e.amount} />
                                  {e.status !== 'PAID' && e.covered !== '0.00' && (
                                    <div className="text-xs text-muted-foreground">
                                      осталось <Money value={e.remaining} tone="plain" />
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
                            value={<Money value={order.schedule.summary.overdueAmount} />}
                            tone="neg"
                            strong
                          />
                        )}
                        {order.schedule.summary.nextDueDate && (
                          <Row
                            label="Следующий платёж"
                            value={
                              <>
                                {formatDate(order.schedule.summary.nextDueDate)} ·{' '}
                                <Money value={order.schedule.summary.nextDueAmount ?? '0'} tone="plain" />
                              </>
                            }
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
                                <Money value={t.amount} tone="plain" />
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
                                {l.qty} × <Money value={l.unitCost} tone="plain" /> · от{' '}
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

                {/* Вход в готовый механизм разбора чеков (P1.4 аудита): бэкенд
                    wb-receipt умеет вынуть позиции из PDF ДНС/ВБ/ОТ и положить их
                    прямо в заказ, но добраться до него можно было только через
                    «Закупки» и там выбирать заказ руками. */}
                <div>
                  <div className="mb-1.5 text-sm font-semibold">Позиции из чека</div>
                  <p className="mb-2 text-sm text-muted-foreground">
                    PDF-чек Wildberries, ДНС или Онлайн Трейд распознаётся сам: позиции лягут
                    в этот заказ с закупочными ценами, деньги привяжутся к строке выписки.
                  </p>
                  <Button
                    variant="secondary"
                    onClick={() =>
                      router.push(
                        `/purchases/wb-receipt?order=${order.id}` as Parameters<
                          typeof router.push
                        >[0],
                      )
                    }
                  >
                    <Receipt className="h-4 w-4" />
                    Разобрать чек
                  </Button>
                </div>
                  </TabsContent>
                </Tabs>

                {error && <p className="text-sm text-destructive">{error}</p>}
              </>
            )}
          </ModalBody>

          {order && order.status !== 'CANCELLED' && (
            <ModalFooter className="flex-wrap">
              <Button
                variant="destructive"
                onClick={() => setConfirmCancel(true)}
                className="sm:mr-auto"
              >
                Отменить
              </Button>
              <Button
                variant="ghost"
                onClick={() => setConfirmDelete(true)}
                className="text-destructive"
              >
                <Trash2 className="h-4 w-4" />
                Удалить
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
                      // Дата денег, а не «сегодня»: иначе подпись в диалоге
                      // обещает дату последней оплаты, а поле её перебивает.
                      setCloseDate(toLocalDateInput(lastPaymentDate ?? new Date()));
                      setCloseOpen(true);
                    }}
                    disabled={finalize.isPending}
                  >
                    {finalize.isPending ? 'Закрытие…' : 'Закрыть заказ'}
                  </Button>
                </>
              )}
            </ModalFooter>
          )}

          {order && order.status === 'CANCELLED' && (
            <ModalFooter className="flex-wrap">
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
              <Button
                variant="ghost"
                onClick={() => setConfirmDelete(true)}
                className="text-destructive"
              >
                <Trash2 className="h-4 w-4" />
                Удалить
              </Button>
            </ModalFooter>
          )}
        </ModalContent>
      </Modal>

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
            <FormField
              label="Дата отгрузки"
              htmlFor="order-close-date"
              required
              hint={
                lastPaymentDate
                  ? `Подставлена дата последней оплаты: ${formatDate(lastPaymentDate)}`
                  : 'Оплат по заказу ещё не было — стоит сегодняшняя дата'
              }
            >
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
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Удалить заказ?"
        confirmText="Удалить заказ"
        description={
          order ? (
            <div className="space-y-2">
              <p>
                {order.number}
                {order.client ? ` · ${order.client.name}` : ''} на {formatRub(order.totalAmount)}{' '}
                исчезнет из списков и отчётов. Отменить удаление из приложения нельзя.
              </p>
              <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                {payments.length > 0 && (
                  <li>
                    сторнируются оплаты: {payments.length} на {formatRub(order.paidAmount)} — деньги
                    уйдут и с остатка счёта;
                  </li>
                )}
                {order.status === 'DONE' && (
                  <li>выручка и себестоимость перестанут учитываться в ОПиУ, склад вернётся;</li>
                )}
                {(order.attachments?.length ?? 0) > 0 && (
                  <li>чеки и документы заказа ({order.attachments?.length}) удалятся насовсем;</li>
                )}
                <li>строки выписки, которыми платили, вернутся во «Входящие».</li>
              </ul>
              <p className="text-xs text-muted-foreground">
                Если заказ реальный, но сорвался — лучше «Отменить»: он останется в истории.
              </p>
            </div>
          ) : null
        }
        onConfirm={async () => {
          if (!order) return;
          await removeOrder.mutateAsync(order.id);
          setConfirmDelete(false);
          onClose();
        }}
        loading={removeOrder.isPending}
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
        <ScheduleModal
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
