import { normalizeClientName } from '@construct/shared';

/**
 * Подбор пар «сделка amoCRM ↔ заказ в учёте» — чистая функция, без сети и БД.
 *
 * Зачем: на момент подключения amo в учёте уже 94 заказа, а в CRM 2267 сделок,
 * и связывать их руками по одной — день работы. Правила выведены из среза
 * прода 20.09.2026: телефон + сумма до копейки дают 34 пары, в которых ФИО
 * совпадают буквально; один телефон без суммы — ещё 22 пары, где это может
 * быть как тот же заказ с изменившимся бюджетом, так и СОСЕДНИЙ заказ того же
 * клиента. Поэтому «отмечено по умолчанию» получает только первая группа.
 */

/** Почему пара предложена. Порядок = приоритет при разборе конфликтов. */
export type MatchReason = 'phone_and_sum' | 'name_and_sum' | 'phone' | 'sum_and_date';

const PRIORITY: Record<MatchReason, number> = {
  phone_and_sum: 0,
  name_and_sum: 1,
  phone: 2,
  sum_and_date: 3,
};

/** Отмечены по умолчанию только совпадения телефона и суммы (решение владельца 20.09.2026). */
export const CONFIDENT_REASONS: MatchReason[] = ['phone_and_sum'];

/** Окно дат для слабого правила «та же сумма примерно в те же дни». */
export const SUM_DATE_WINDOW_DAYS = 14;

export interface MatchDeal {
  id: string;
  price: string;
  phone: string | null;
  contactName: string | null;
  name: string;
  remoteCreatedAt: Date;
}

export interface MatchOrder {
  id: string;
  phone: string | null;
  totalAmount: string;
  clientName: string | null;
  createdAt: Date;
}

export interface MatchPair {
  dealId: string;
  orderId: string;
  reason: MatchReason;
  /** Отметить галочкой сразу. */
  confident: boolean;
  /** Расхождение дат в днях — показать человеку, когда сумма сошлась, а телефона нет. */
  daysApart: number;
}

const money = (v: string) => Number(v);
const sameMoney = (a: string, b: string) => money(a) === money(b);
const daysBetween = (a: Date, b: Date) => Math.abs(a.getTime() - b.getTime()) / 86_400_000;

/** Имя контакта сделки против имени клиента заказа, с нормализацией «ё»/пробелов. */
function sameName(deal: MatchDeal, order: MatchOrder): boolean {
  const orderName = normalizeClientName(order.clientName);
  if (!orderName) return false;
  // У сделки имя человека бывает и в контакте, и в названии («Габалова Елена (Р)»).
  const dealNames = [deal.contactName, deal.name].map(normalizeClientName).filter(Boolean);
  return dealNames.some((n) => n === orderName || n.startsWith(`${orderName} `));
}

function reasonFor(deal: MatchDeal, order: MatchOrder): MatchReason | null {
  const phoneMatch = !!deal.phone && !!order.phone && deal.phone === order.phone;
  const sumMatch = sameMoney(deal.price, order.totalAmount);
  if (phoneMatch && sumMatch) return 'phone_and_sum';
  if (sumMatch && sameName(deal, order)) return 'name_and_sum';
  if (phoneMatch) return 'phone';
  if (sumMatch && daysBetween(deal.remoteCreatedAt, order.createdAt) <= SUM_DATE_WINDOW_DAYS) {
    return 'sum_and_date';
  }
  return null;
}

/**
 * Пары «один к одному»: сделка и заказ, уже занятые более сильной парой, во
 * вторую не попадают. Иначе повторные заказы одного клиента размножили бы
 * предложения и человек привязал бы сделку к чужому заказу.
 */
export function matchDealsToOrders(deals: MatchDeal[], orders: MatchOrder[]): MatchPair[] {
  const candidates: MatchPair[] = [];
  for (const deal of deals) {
    for (const order of orders) {
      const reason = reasonFor(deal, order);
      if (!reason) continue;
      candidates.push({
        dealId: deal.id,
        orderId: order.id,
        reason,
        confident: CONFIDENT_REASONS.includes(reason),
        daysApart: Math.round(daysBetween(deal.remoteCreatedAt, order.createdAt)),
      });
    }
  }
  // Сильное правило вперёд; внутри правила — пара с ближайшими датами (повторный
  // заказ того же клиента отличается именно датой).
  candidates.sort((a, b) => PRIORITY[a.reason] - PRIORITY[b.reason] || a.daysApart - b.daysApart);

  const usedDeals = new Set<string>();
  const usedOrders = new Set<string>();
  const pairs: MatchPair[] = [];
  for (const c of candidates) {
    if (usedDeals.has(c.dealId) || usedOrders.has(c.orderId)) continue;
    usedDeals.add(c.dealId);
    usedOrders.add(c.orderId);
    pairs.push(c);
  }
  return pairs;
}
