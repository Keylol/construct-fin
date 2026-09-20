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
export type MatchReason = 'phone_and_sum' | 'name_and_sum' | 'phone' | 'name' | 'sum_and_date';

const PRIORITY: Record<MatchReason, number> = {
  phone_and_sum: 0,
  name_and_sum: 1,
  phone: 2,
  name: 3,
  sum_and_date: 4,
};

/**
 * Допуск при сравнении сумм — рубль. amo хранит бюджет целыми рублями, а заказ
 * в учёте с копейками: «304 658» в CRM и «304 658,17» в заказе — одна и та же
 * продажа. Без допуска 20.09.2026 девять сделок не нашли своих заказов, и
 * «Завести заказ» по ним создало бы дубли.
 */
const MONEY_EPS = 1;

/**
 * Отмечены по умолчанию совпадения телефона и суммы, а также ФИО и суммы:
 * второе на срезе прода давало ровно те же продажи (Новаков, Каменская,
 * Бугаев…), просто в сделке не заполнен телефон.
 */
export const CONFIDENT_REASONS: MatchReason[] = ['phone_and_sum', 'name_and_sum'];

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
const sameMoney = (a: string, b: string) => Math.abs(money(a) - money(b)) <= MONEY_EPS;
const daysBetween = (a: Date, b: Date) => Math.abs(a.getTime() - b.getTime()) / 86_400_000;

/**
 * Куски названия сделки, в которых может прятаться ФИО. Менеджеры пишут
 * «Габалова Елена Геннадиевна (Р)», «Копылов Владимир Алексеевич(Р)» (скобка
 * вплотную) и «В чате Константин/ Семёнова Татьяна Викторовна(Р)» — имя в
 * середине. Поэтому режем по «/», снимаем скобочные пометки и лишние знаки.
 */
function nameParts(raw: string | null | undefined): string[] {
  return (raw ?? '')
    .split('/')
    .map((part) => normalizeClientName(part.replace(/\([^)]*\)/g, ' ').replace(/[«»"']/g, ' ')))
    .filter((part) => part.length >= 4);
}

/**
 * Имя клиента заказа против имён из сделки. Совпадением считаем не только
 * равенство, но и вхождение одного в другое целыми словами: в CRM к ФИО
 * дописывают пометки, в учёте их нет.
 */
function sameName(deal: MatchDeal, order: MatchOrder): boolean {
  const orderName = normalizeClientName(order.clientName);
  // Одного слова мало: «Александр» совпал бы с любым другим Александром.
  if (!orderName || orderName.split(' ').length < 2) return false;
  const candidates = [...nameParts(deal.contactName), ...nameParts(deal.name)];
  return candidates.some(
    (n) => n === orderName || n.startsWith(`${orderName} `) || n.includes(` ${orderName}`),
  );
}

function reasonFor(deal: MatchDeal, order: MatchOrder): MatchReason | null {
  const phoneMatch = !!deal.phone && !!order.phone && deal.phone === order.phone;
  const sumMatch = sameMoney(deal.price, order.totalAmount);
  const nameMatch = sameName(deal, order);
  if (phoneMatch && sumMatch) return 'phone_and_sum';
  if (sumMatch && nameMatch) return 'name_and_sum';
  if (phoneMatch) return 'phone';
  // Имя сошлось, а сумма нет: бюджет в CRM не обновили после правки заказа.
  // Пара показывается без галочки — решает человек.
  if (nameMatch) return 'name';
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

/**
 * Подсказка «этот приход — по сделке amoCRM»: строка выписки и сделка сошлись
 * по сумме. amo округляет бюджет до рубля, банк приносит копейки: платёж
 * 150 198,25 против сделки 150 198 — одна и та же продажа (случай Донгака,
 * Гаммаева, Лопатина на проде 20.09.2026). Поэтому допуск тот же, что и при
 * сопоставлении с заказами, — рубль.
 */
export interface MatchLine {
  id: string;
  amount: string;
  date: Date;
}

export interface LineDealPair {
  lineId: string;
  dealId: string;
  /** Разница сумм в рублях — показать человеку, почему пара предложена. */
  diff: number;
}

/**
 * Пары «строка выписки ↔ сделка», один к одному: две строки на одну сделку —
 * это либо предоплата и доплата, либо ошибка, и разбирать их нужно руками.
 * При равном совпадении берём сделку, ближайшую по дате к платежу.
 */
export function matchLinesToDeals(lines: MatchLine[], deals: MatchDeal[]): LineDealPair[] {
  const candidates: (LineDealPair & { daysApart: number })[] = [];
  for (const line of lines) {
    for (const deal of deals) {
      const diff = Math.abs(money(line.amount) - money(deal.price));
      if (diff > MONEY_EPS) continue;
      candidates.push({
        lineId: line.id,
        dealId: deal.id,
        diff: Math.round(diff * 100) / 100,
        daysApart: Math.round(daysBetween(line.date, deal.remoteCreatedAt)),
      });
    }
  }
  candidates.sort((a, b) => a.diff - b.diff || a.daysApart - b.daysApart);

  const usedLines = new Set<string>();
  const usedDeals = new Set<string>();
  const pairs: LineDealPair[] = [];
  for (const c of candidates) {
    if (usedLines.has(c.lineId) || usedDeals.has(c.dealId)) continue;
    usedLines.add(c.lineId);
    usedDeals.add(c.dealId);
    pairs.push({ lineId: c.lineId, dealId: c.dealId, diff: c.diff });
  }
  return pairs;
}
