/**
 * Расхождения между amoCRM и учётом — «что потерялось».
 *
 * Смысл интеграции не в том, чтобы показать сделки рядом, а в том, чтобы ни
 * одна продажа не выпала из учёта. Правила выведены из среза прода 20.09.2026,
 * где нашлось: 27 выигранных сделок на 4 012 247 ₽ без заказа (выручка не
 * признана), 12 выигранных сделок с неоплаченным заказом (CRM считает сделку
 * закрытой, деньги пришли не все), 18 закрытых заказов с открытой сделкой.
 *
 * Чистые правила, без сети и БД: на входе снимок, на выходе проверки со
 * списками. Так их поведение проверяется юнитами, а не глазами на проде.
 */

export type DiscrepancyTone = 'destructive' | 'warning' | 'ok';

export type DiscrepancyKey =
  | 'won_without_order'
  | 'won_unpaid'
  | 'order_done_deal_open'
  | 'sum_mismatch'
  | 'order_without_deal'
  | 'sync_stale';

export interface DiscrepancyItem {
  /** Сделка amo, если расхождение про неё. */
  dealId?: string;
  externalId?: number;
  dealName?: string;
  dealStatus?: string;
  /** Заказ учёта, если расхождение про него. */
  orderId?: string;
  orderNumber?: string;
  clientName?: string | null;
  /** Деньги строки: бюджет сделки, долг по заказу или разница сумм. */
  amount: string;
  /** Дата, по которой сортируем и объясняем: закрытие сделки или создание заказа. */
  date: string;
}

export interface DiscrepancyCheck {
  key: DiscrepancyKey;
  title: string;
  /** Чем это грозит — человеческим языком, без терминов интеграции. */
  hint: string;
  tone: DiscrepancyTone;
  count: number;
  /** Сумма денег под расхождением; '0.00', когда деньги ни при чём. */
  sum: string;
  items: DiscrepancyItem[];
}

export interface SnapshotDeal {
  id: string;
  externalId: number;
  name: string;
  statusName: string;
  price: string;
  isWon: boolean;
  isClosed: boolean;
  dismissedAt: Date | null;
  remoteClosedAt: Date | null;
  remoteUpdatedAt: Date;
  order: SnapshotOrder | null;
}

export interface SnapshotOrder {
  id: string;
  number: string;
  status: string;
  totalAmount: string;
  paidAmount: string;
  clientName: string | null;
  createdAt: Date;
  /** Есть ли у заказа привязанная сделка — для проверки «заказ мимо CRM». */
  hasDeal: boolean;
}

export interface SnapshotConnection {
  status: string;
  lastSyncAt: Date | null;
  lastSyncError: string | null;
}

/**
 * Сколько показывать в списке под проверкой: остальное человек смотрит в
 * разделе. Сто строк в карточке никто не читает, а запрос тяжелеет.
 */
export const ITEMS_LIMIT = 50;

/** Синк считается «молчащим» после этого срока без успешного обновления. */
export const SYNC_STALE_MINUTES = 90;

/** Деньги сходятся с точностью до рубля: amo округляет бюджет (см. crm-match). */
const MONEY_EPS = 1;

const money = (v: string) => Number(v);
const sum = (items: { amount: string }[]) =>
  items.reduce((acc, i) => acc + money(i.amount), 0).toFixed(2);
const byDateDesc = (a: DiscrepancyItem, b: DiscrepancyItem) => b.date.localeCompare(a.date);

/**
 * Только сделки, закрытые не раньше этой даты: у владельца в CRM лежит история
 * за годы, а учёт в приложении начался позже. Старое сюда тянуть бессмысленно —
 * это не потеря, а другой период.
 */
export interface DiscrepancyOptions {
  /** Продажи раньше этой даты в расхождения не попадают. */
  since: Date;
  now: Date;
}

export function buildDiscrepancies(
  deals: SnapshotDeal[],
  orders: SnapshotOrder[],
  connection: SnapshotConnection | null,
  opts: DiscrepancyOptions,
): DiscrepancyCheck[] {
  const live = deals.filter((d) => !d.dismissedAt);
  const closedAt = (d: SnapshotDeal) => d.remoteClosedAt ?? d.remoteUpdatedAt;
  const fresh = (d: SnapshotDeal) => closedAt(d) >= opts.since;

  // 1. Продажа состоялась в CRM, а заказа в учёте нет: выручка не признана,
  //    себестоимость не посчитана, клиент в отчётах не виден.
  const wonWithoutOrder = live
    .filter((d) => d.isWon && !d.order && fresh(d))
    .map(
      (d): DiscrepancyItem => ({
        dealId: d.id,
        externalId: d.externalId,
        dealName: d.name,
        dealStatus: d.statusName,
        amount: d.price,
        date: closedAt(d).toISOString(),
      }),
    )
    .sort(byDateDesc);

  // 2. В CRM сделка выиграна, а заказ оплачен не полностью: дебиторка, которую
  //    менеджер уже считает закрытой, — деньги потеряются тише всего.
  const wonUnpaid = live
    .filter(
      (d) =>
        d.isWon && d.order && money(d.order.paidAmount) + MONEY_EPS < money(d.order.totalAmount),
    )
    .map(
      (d): DiscrepancyItem => ({
        dealId: d.id,
        externalId: d.externalId,
        dealName: d.name,
        orderId: d.order!.id,
        orderNumber: d.order!.number,
        clientName: d.order!.clientName,
        amount: (money(d.order!.totalAmount) - money(d.order!.paidAmount)).toFixed(2),
        date: closedAt(d).toISOString(),
      }),
    )
    .sort(byDateDesc);

  // 3. Заказ в учёте закрыт, а сделка в CRM висит в работе: воронка врёт, и
  //    менеджер может позвонить клиенту по уже закрытой продаже.
  const orderDoneDealOpen = live
    .filter((d) => d.order?.status === 'DONE' && !d.isClosed)
    .map(
      (d): DiscrepancyItem => ({
        dealId: d.id,
        externalId: d.externalId,
        dealName: d.name,
        dealStatus: d.statusName,
        orderId: d.order!.id,
        orderNumber: d.order!.number,
        clientName: d.order!.clientName,
        amount: d.order!.totalAmount,
        date: d.order!.createdAt.toISOString(),
      }),
    )
    .sort(byDateDesc);

  // 4. Суммы разошлись больше чем на рубль: либо бюджет в CRM не обновили после
  //    правки заказа, либо привязали не ту сделку.
  const sumMismatch = live
    .filter((d) => d.order && Math.abs(money(d.price) - money(d.order.totalAmount)) > MONEY_EPS)
    .map(
      (d): DiscrepancyItem => ({
        dealId: d.id,
        externalId: d.externalId,
        dealName: d.name,
        orderId: d.order!.id,
        orderNumber: d.order!.number,
        clientName: d.order!.clientName,
        amount: Math.abs(money(d.price) - money(d.order!.totalAmount)).toFixed(2),
        date: d.order!.createdAt.toISOString(),
      }),
    )
    .sort(byDateDesc);

  // 5. Заказ есть, сделки нет: продажа прошла мимо CRM, канал привлечения
  //    неизвестен, и в аналитике «маржа по источнику» её не будет.
  const orderWithoutDeal = orders
    .filter((o) => !o.hasDeal && o.status !== 'CANCELLED' && o.createdAt >= opts.since)
    .map(
      (o): DiscrepancyItem => ({
        orderId: o.id,
        orderNumber: o.number,
        clientName: o.clientName,
        amount: o.totalAmount,
        date: o.createdAt.toISOString(),
      }),
    )
    .sort(byDateDesc);

  // 6. Молчащий синк: без него все проверки выше считают по устаревшему снимку
  //    и показывают «всё хорошо» просто потому, что данных нет.
  const staleMs = SYNC_STALE_MINUTES * 60 * 1000;
  const syncBroken =
    !connection ||
    connection.status === 'ERROR' ||
    !connection.lastSyncAt ||
    opts.now.getTime() - connection.lastSyncAt.getTime() > staleMs;

  const checks: DiscrepancyCheck[] = [
    {
      key: 'won_without_order',
      title: 'Продажа в amoCRM без заказа',
      hint: 'Сделка выиграна, а заказа в учёте нет: выручка и себестоимость по ней не посчитаны.',
      tone: wonWithoutOrder.length > 0 ? 'destructive' : 'ok',
      count: wonWithoutOrder.length,
      sum: sum(wonWithoutOrder),
      items: wonWithoutOrder.slice(0, ITEMS_LIMIT),
    },
    {
      key: 'won_unpaid',
      title: 'Выиграна, но оплачена не полностью',
      hint: 'В amoCRM сделка закрыта успешно, а по заказу остался долг — в CRM его не видно.',
      tone: wonUnpaid.length > 0 ? 'destructive' : 'ok',
      count: wonUnpaid.length,
      sum: sum(wonUnpaid),
      items: wonUnpaid.slice(0, ITEMS_LIMIT),
    },
    {
      key: 'order_done_deal_open',
      title: 'Заказ закрыт, сделка открыта',
      hint: 'Заказ в учёте выполнен, а сделка висит в работе: воронка показывает лишнее.',
      tone: orderDoneDealOpen.length > 0 ? 'warning' : 'ok',
      count: orderDoneDealOpen.length,
      sum: sum(orderDoneDealOpen),
      items: orderDoneDealOpen.slice(0, ITEMS_LIMIT),
    },
    {
      key: 'sum_mismatch',
      title: 'Суммы заказа и сделки разошлись',
      hint: 'Бюджет в amoCRM не обновили после правки заказа — либо привязана не та сделка.',
      tone: sumMismatch.length > 0 ? 'warning' : 'ok',
      count: sumMismatch.length,
      sum: sum(sumMismatch),
      items: sumMismatch.slice(0, ITEMS_LIMIT),
    },
    {
      key: 'order_without_deal',
      title: 'Заказ без сделки в amoCRM',
      hint: 'Продажа прошла мимо CRM: источник привлечения неизвестен, в аналитике канала её нет.',
      tone: orderWithoutDeal.length > 0 ? 'warning' : 'ok',
      count: orderWithoutDeal.length,
      sum: sum(orderWithoutDeal),
      items: orderWithoutDeal.slice(0, ITEMS_LIMIT),
    },
    {
      key: 'sync_stale',
      title: 'Синхронизация с amoCRM',
      hint: syncBroken
        ? 'Пока синк молчит, проверки считают по устаревшему снимку и могут показывать «всё хорошо» на пустом месте.'
        : 'Снимок сделок свежий.',
      tone: syncBroken ? 'destructive' : 'ok',
      count: syncBroken ? 1 : 0,
      sum: '0.00',
      items: [],
    },
  ];
  return checks;
}
