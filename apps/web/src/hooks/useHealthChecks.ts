'use client';

import { useMemo } from 'react';
import { formatRub } from '@construct/shared';
import { useAccounts, useAccountBalances } from '@/hooks/useAccounts';
import { useInboxCount } from '@/hooks/useInbox';
import { useOrders } from '@/hooks/useOrders';
import { useReceivables } from '@/hooks/useTradeReports';
import { useWarehouse } from '@/hooks/useWarehouse';
import { canCloseOrder } from '@/components/orders/order-shared';
import { plural } from '@/lib/plural';

export type HealthTone = 'destructive' | 'warning' | 'ok';

export interface HealthCheck {
  key: string;
  /** Короткое имя проверки — заголовок строки. */
  title: string;
  /** Что именно нашли: суммы, количества. Пусто, когда всё чисто. */
  detail: string;
  tone: HealthTone;
  /** Куда идти исправлять. */
  href: string;
  /** Сколько объектов требует внимания (0 = проверка пройдена). */
  count: number;
}

/**
 * Проверки состояния учёта — «что не доделано прямо сейчас».
 *
 * Один источник для двух мест: на дашборде показываются только сработавшие
 * (виджет «Требует внимания»), на странице «Здоровье» — все, включая пройденные,
 * потому что там важно видеть и то, что проверено и чисто.
 *
 * Считается на клиенте из уже загружаемых запросов: отдельного эндпоинта нет,
 * а все нужные данные экраны и так тянут.
 */
export function useHealthChecks(wsId: string | null) {
  const inboxCount = useInboxCount(wsId);
  const receivables = useReceivables(wsId);
  const accounts = useAccounts(wsId);
  const balances = useAccountBalances(wsId);
  const warehouse = useWarehouse(wsId);
  // Оплаченные, но не закрытые: выручка по ним ещё не признана (учёт по
  // реализации), поэтому месяц выглядит беднее, чем есть.
  const openOrders = useOrders(wsId, { status: 'OPEN', limit: 100 });

  const isLoading =
    inboxCount.isLoading ||
    receivables.isLoading ||
    accounts.isLoading ||
    balances.isLoading ||
    warehouse.isLoading ||
    openOrders.isLoading;

  const checks = useMemo<HealthCheck[]>(() => {
    const out: HealthCheck[] = [];

    // 1. Строки выписки на разборе
    const inbox = inboxCount.data?.count ?? 0;
    out.push({
      key: 'inbox',
      title: 'Строки выписки на разборе',
      detail: inbox
        ? `${inbox} ${plural(inbox, 'строка', 'строки', 'строк')} ждут категории или привязки к заказу`
        : 'Все строки банка обработаны',
      tone: inbox > 0 ? 'warning' : 'ok',
      href: '/inbox',
      count: inbox,
    });

    // 2. Заказы, которые пора закрыть
    const orders = openOrders.data?.pages.flatMap((p) => p.items) ?? [];
    const closable = orders.filter(canCloseOrder);
    out.push({
      key: 'closable-orders',
      title: 'Оплаченные заказы без закрытия',
      detail: closable.length
        ? `${closable.length} ${plural(closable.length, 'заказ оплачен', 'заказа оплачены', 'заказов оплачены')} полностью — до закрытия выручка не признана`
        : 'Все оплаченные заказы закрыты',
      tone: closable.length > 0 ? 'warning' : 'ok',
      href: '/orders',
      count: closable.length,
    });

    // 3. Просроченные платежи клиентов
    const overdue = receivables.data?.overdueByPlanTotal ?? '0';
    const overdueClients = (receivables.data?.clients ?? []).filter(
      (c) => Number(c.overdueByPlan) > 0,
    );
    out.push({
      key: 'overdue',
      title: 'Просроченные платежи',
      detail: overdueClients.length
        ? `${formatRub(overdue)} у ${overdueClients.length} ${plural(overdueClients.length, 'клиента', 'клиентов', 'клиентов')}`
        : 'Просрочек по графикам нет',
      tone: overdueClients.length > 0 ? 'destructive' : 'ok',
      href: '/reports/receivables',
      count: overdueClients.length,
    });

    // 4. Счета в минусе — обычно это незаведённое пополнение, а не реальный овердрафт
    const negative = (accounts.data ?? [])
      .map((a) => ({ name: a.name, balance: balances.data?.get(a.id) ?? '0' }))
      .filter((a) => Number(a.balance) < 0);
    out.push({
      key: 'negative-accounts',
      title: 'Счета в минусе',
      detail: negative.length
        ? negative.map((a) => `${a.name}: ${formatRub(a.balance)}`).join(', ')
        : 'Все остатки неотрицательные',
      tone: negative.length > 0 ? 'destructive' : 'ok',
      href: '/accounts',
      count: negative.length,
    });

    // 5. Склад без себестоимости — маржа по таким позициям остаётся оценкой
    const noCost = (warehouse.data ?? []).filter(
      (w) => Number(w.qty) > 0 && Number(w.avgCost) === 0,
    );
    out.push({
      key: 'no-cost',
      title: 'Позиции склада без себестоимости',
      detail: noCost.length
        ? `${noCost.length} ${plural(noCost.length, 'позиция', 'позиции', 'позиций')} с остатком, но без цены закупки — маржа по ним оценочная`
        : 'У всех остатков есть себестоимость',
      tone: noCost.length > 0 ? 'warning' : 'ok',
      href: '/warehouse',
      count: noCost.length,
    });

    return out;
  }, [
    inboxCount.data,
    openOrders.data,
    receivables.data,
    accounts.data,
    balances.data,
    warehouse.data,
  ]);

  const failing = checks.filter((c) => c.tone !== 'ok');

  return { checks, failing, isLoading };
}
