import { formatPhone } from '@construct/shared';
import type { BankLineStatus, OrderStatus } from '@/lib/types';
import type {
  GlobalSearchGroup,
  GlobalSearchResponse,
  TransactionHit,
} from '@/hooks/useGlobalSearch';
import { formatDate } from '@/lib/dates';
import { txDrilldownHref } from '@/lib/tx-filters';

/**
 * Как показать найденное общим поиском и куда оно ведёт. Ссылки — только на
 * экраны, которые умеют открыть запись: карточку заказа и закупки по `?order=` и
 * `?purchase=`, списки — с тем же запросом в `?q=`.
 *
 * Группа показывается, только если её раздел есть в меню роли (`visible`): так
 * оператор не видит того, что ему закрыто, а скрытый раздел не открывается из
 * поиска. Поставщик и контрагент при скрытом разделе ведут туда, где с ними
 * работают: к закупкам поставщика и к операциям контрагента.
 */

export type SearchGroupKey = GlobalSearchGroup['key'];

export interface SearchHitView {
  id: string;
  title: string;
  subtitle: string | null;
  /** Сумма справа; со знаком минус — расход. */
  amount: string | null;
  /** Короткая пометка справа: статус, «архив», остаток на складе. */
  aside: string | null;
  href: string;
}

export interface SearchGroupView {
  key: SearchGroupKey;
  heading: string;
  total: number;
  /** «Показать все» — экран раздела с тем же запросом; null — такого фильтра у раздела нет. */
  moreHref: string | null;
  items: SearchHitView[];
}

const ORDER_STATUS: Record<OrderStatus, string | null> = {
  OPEN: null,
  DONE: 'закрыт',
  CANCELLED: 'отменён',
};

const INBOX_STATUS: Record<BankLineStatus, string> = {
  NEW: 'не разобрано',
  AUTO_POSTED: 'проведено правилами',
  RESOLVED: 'обработано',
  DISMISSED: 'не учитывается',
};

/** Раньше этой даты учёта нет — «за всё время» для операций контрагента. */
const ALL_TIME_FROM = '2020-01-01T07:00:00.000Z';

const enc = encodeURIComponent;

function join(...parts: Array<string | null | undefined | false>): string | null {
  return parts.filter(Boolean).join(' · ') || null;
}

function transactionHref(t: TransactionHit, visible: (href: string) => boolean): string {
  if (t.orderId && visible('/orders')) return `/orders?order=${t.orderId}`;
  if (t.purchaseId && visible('/purchases')) return `/purchases?purchase=${t.purchaseId}`;
  // Отдельного адреса у операции нет — открываем список за её день (и по её контрагенту).
  return txDrilldownHref({
    from: t.date,
    to: t.date,
    ...(t.counterpartyId ? { counterpartyId: t.counterpartyId } : {}),
  });
}

function describeGroup(
  group: GlobalSearchGroup,
  q: string,
  visible: (href: string) => boolean,
): SearchGroupView | null {
  switch (group.key) {
    case 'orders':
      if (!visible('/orders')) return null;
      return {
        key: group.key,
        heading: 'Заказы',
        total: group.total,
        moreHref: `/orders?q=${q}`,
        items: group.items.map((o) => ({
          id: o.id,
          title: o.title ?? o.number,
          subtitle: join(o.clientName, o.phone && formatPhone(o.phone), o.title ? o.number : null),
          amount: o.totalAmount,
          aside: ORDER_STATUS[o.status],
          href: `/orders?order=${o.id}`,
        })),
      };

    case 'clients':
    case 'suppliers':
    case 'employees':
    case 'counterparties': {
      const base = {
        clients: { heading: 'Клиенты', section: '/clients' },
        suppliers: { heading: 'Поставщики', section: '/suppliers' },
        employees: { heading: 'Сотрудники', section: '/salary' },
        counterparties: { heading: 'Контрагенты', section: '/counterparties' },
      }[group.key];
      const own = visible(base.section);
      const hrefFor = (c: { id: string; name: string }): string | null => {
        switch (group.key) {
          case 'clients':
            return own ? `/clients/${c.id}` : null;
          case 'suppliers':
            if (own) return `/suppliers/${c.id}`;
            return visible('/purchases') ? `/purchases?q=${enc(c.name)}` : null;
          case 'employees':
            return own ? `/salary?q=${enc(c.name)}` : null;
          case 'counterparties':
            if (own) return `/counterparties?q=${enc(c.name)}`;
            return visible('/transactions')
              ? txDrilldownHref({
                  counterpartyId: c.id,
                  from: ALL_TIME_FROM,
                  to: new Date().toISOString(),
                })
              : null;
        }
      };
      const items = group.items.flatMap((c) => {
        const href = hrefFor(c);
        return href
          ? [
              {
                id: c.id,
                title: c.name,
                subtitle: join(c.contact, c.inn && `ИНН ${c.inn}`),
                amount: null,
                aside: c.isArchived ? 'архив' : null,
                href,
              },
            ]
          : [];
      });
      if (items.length === 0) return null;
      const moreSection = group.key === 'employees' ? '/salary' : base.section;
      return {
        key: group.key,
        heading: base.heading,
        total: group.total,
        moreHref: own ? `${moreSection}?q=${q}` : null,
        items,
      };
    }

    case 'transactions':
      if (!visible('/transactions')) return null;
      return {
        key: group.key,
        heading: 'Операции',
        total: group.total,
        moreHref: `/transactions?q=${q}&period=all`,
        items: group.items.map((t) => ({
          id: t.id,
          title: t.description ?? t.counterpartyName ?? t.categoryName ?? 'Операция',
          subtitle: join(
            formatDate(t.date),
            t.accountName,
            t.description ? t.counterpartyName : null,
            t.categoryName,
          ),
          amount: t.type === 'EXPENSE' ? `-${t.amount}` : t.amount,
          aside: null,
          href: transactionHref(t, visible),
        })),
      };

    case 'inbox': {
      if (!visible('/inbox')) return null;
      const byStatus = group.byStatus;
      const tab =
        (['NEW', 'AUTO_POSTED', 'RESOLVED', 'DISMISSED'] as const).find(
          (s) => (byStatus[s] ?? 0) > 0,
        ) ?? 'NEW';
      return {
        key: group.key,
        heading: 'Входящие',
        total: group.total,
        moreHref: `/inbox?tab=${tab}&q=${q}`,
        items: group.items.map((l) => ({
          id: l.id,
          title: l.counterpartyName ?? l.description ?? 'Строка выписки',
          subtitle: join(formatDate(l.date), l.accountName, INBOX_STATUS[l.status]),
          amount: l.direction === 'EXPENSE' ? `-${l.amount}` : l.amount,
          aside: null,
          href: `/inbox?tab=${l.status}&q=${q}`,
        })),
      };
    }

    case 'purchases':
      if (!visible('/purchases')) return null;
      return {
        key: group.key,
        heading: 'Закупки',
        total: group.total,
        moreHref: `/purchases?q=${q}`,
        items: group.items.map((p) => ({
          id: p.id,
          title: p.supplierName ?? 'Закупка',
          subtitle: join(formatDate(p.date), `${p.linesCount} поз.`, p.note),
          amount: p.amount,
          aside: null,
          href: `/purchases?purchase=${p.id}`,
        })),
      };

    case 'warehouse':
      if (!visible('/warehouse')) return null;
      return {
        key: group.key,
        heading: 'Склад',
        total: group.total,
        moreHref: `/warehouse?q=${q}`,
        items: group.items.map((w) => ({
          id: w.id,
          title: w.name,
          subtitle: w.sku,
          amount: null,
          aside: w.isArchived ? 'архив' : `${w.qty} ${w.unit}`,
          href: `/warehouse?q=${enc(w.name)}`,
        })),
      };

    case 'accounts':
      if (!visible('/accounts')) return null;
      return {
        key: group.key,
        heading: 'Счета',
        total: group.total,
        moreHref: `/accounts?q=${q}`,
        items: group.items.map((a) => ({
          id: a.id,
          title: a.name,
          subtitle: null,
          amount: null,
          aside: a.isArchived ? 'архив' : null,
          href: `/accounts?q=${enc(a.name)}`,
        })),
      };

    case 'categories':
      if (!visible('/categories')) return null;
      return {
        key: group.key,
        heading: 'Категории',
        total: group.total,
        moreHref: null,
        items: group.items.map((c) => ({
          id: c.id,
          title: c.name,
          subtitle: c.kind === 'INCOME' ? 'доход' : 'расход',
          amount: null,
          aside: c.isArchived ? 'архив' : null,
          href: `/categories?kind=${c.kind}&q=${enc(c.name)}`,
        })),
      };
  }
}

export function describeSearchGroups(
  response: GlobalSearchResponse,
  visible: (href: string) => boolean,
): SearchGroupView[] {
  const q = enc(response.query);
  return response.groups
    .map((group) => describeGroup(group, q, visible))
    .filter((view): view is SearchGroupView => view !== null && view.items.length > 0);
}
