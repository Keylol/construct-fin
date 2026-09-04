/**
 * Подбор строки выписки под конкретный заказ («Найти оплату»).
 *
 * Главный тупик ручной работы: во «Входящих» сотни строк, и найти среди них
 * оплату конкретного заказа поиском по сумме удаётся не всегда — при торговом
 * эквайринге банк зачисляет нетто, и сумма клиента в выписке просто не
 * встречается. Агент искал такие строки по фамилии, по конфигу сборки из
 * назначения и по фрагменту даты расчёта; здесь то же самое делает код.
 *
 * Функция ТОЛЬКО предлагает, привязывает человек — как transfer-match и
 * planned-match. Ошибочная привязка чужого платежа уже случалась (заказ
 * Савтикова, «Переплата»), и цена автоматики здесь выше цены ручного клика.
 */

import { D, money, sub } from './money';
import { parseAcquiringFee } from './acquiring-fee';

export interface PaymentCandidateLine {
  id: string;
  /** Сумма строки, Decimal-строкой; знак не важен — сравнивается модуль. */
  amount: string;
  description?: string | null;
  counterpartyName?: string | null;
}

export interface PaymentMatchOrder {
  /** Сколько осталось получить по заказу: totalAmount − paidAmount. */
  remaining: string;
  /** ФИО клиента заказа, если он указан. */
  clientName?: string | null;
  /** Название заказа — обычно конфиг сборки, он часто попадает в назначение. */
  title?: string | null;
}

export interface RankedPaymentCandidate<L extends PaymentCandidateLine = PaymentCandidateLine> {
  line: L;
  /** Чем больше, тем вероятнее совпадение. Служит только для сортировки. */
  score: number;
  /** Человекочитаемые причины — их показывает UI, чтобы решал человек. */
  reasons: string[];
}

/** Веса признаков: точная сумма важнее брутто, брутто — важнее имени. */
const SCORE_EXACT = 100;
const SCORE_GROSS = 90;
const SCORE_CLIENT = 40;
const SCORE_TITLE = 20;

/** Ё и регистр не должны мешать: банки пишут ФИО как попало. */
function normalize(raw: string | null | undefined): string {
  return (raw ?? '').toLowerCase().replace(/ё/g, 'е');
}

/**
 * Значимые слова названия заказа: конфиг сборки («RTX 5080», «9800X3D»,
 * «CONSTRUCTPC»). Короткие куски отбрасываем — «ПК» или «7» найдутся в любой
 * строке выписки и превратят подсказку в шум.
 */
function significantTokens(raw: string | null | undefined): string[] {
  return normalize(raw)
    .split(/[^a-zа-я0-9]+/i)
    .filter((t) => t.length >= 4);
}

/** Слова ФИО: фамилии и имён достаточно, отчество ничего не добавляет. */
function nameTokens(raw: string | null | undefined): string[] {
  return normalize(raw)
    .split(/[^a-zа-я-]+/i)
    .filter((t) => t.length >= 4);
}

/**
 * Ранжирует строки выписки как кандидатов на оплату заказа.
 *
 * Признаки (по убыванию веса):
 * 1. сумма строки равна остатку заказа;
 * 2. брутто-совпадение: строка + комиссия, удержанная банком внутри возмещения
 *    (`parseAcquiringFee`), равны остатку — тот самый случай, когда поиск по
 *    сумме клиента не находит ничего;
 * 3. фамилия или имя клиента встречаются в контрагенте либо назначении;
 * 4. слово из названия заказа встречается в назначении.
 *
 * Строки без единого признака не возвращаются вовсе: показать «всё подряд» —
 * значит вернуть человека к тому же списку из сотен строк.
 */
/**
 * Оценивает ОДНУ пару «строка выписки ↔ заказ». Общая для обоих направлений
 * подбора: из карточки заказа ищут строку, из «Входящих» — заказ. Признаки и
 * веса обязаны быть одни, иначе два экрана начнут спорить, что кому подходит.
 */
export function scorePaymentPair(
  line: PaymentCandidateLine,
  order: PaymentMatchOrder,
): { score: number; reasons: string[] } {
  const remaining = money(order.remaining);
  const clientParts = nameTokens(order.clientName);
  const titleParts = significantTokens(order.title);

  const haystack = `${normalize(line.counterpartyName)} ${normalize(line.description)}`;
  // Имя ищем по целым словам: подстрока роднит «Александра» с «Александровной»
  // и подсовывает платёж чужого клиента (поймано на живом заказе Макарова).
  const haystackWords = new Set(haystack.split(/[^a-zа-я0-9-]+/i).filter(Boolean));
  const amount = money(D(line.amount).abs());
  const reasons: string[] = [];
  let score = 0;

  if (amount.equals(remaining)) {
    score += SCORE_EXACT;
    reasons.push('сумма равна остатку по заказу');
  } else {
    const fee = parseAcquiringFee(line.description);
    if (fee && money(amount.plus(D(fee))).equals(remaining)) {
      score += SCORE_GROSS;
      reasons.push(`с комиссией эквайринга ${fee} даёт остаток по заказу`);
    }
  }

  const clientHit = clientParts.find((p) => haystackWords.has(p));
  if (clientHit) {
    score += SCORE_CLIENT;
    reasons.push('клиент упомянут в строке');
  }

  const titleHit = titleParts.find((p) => haystack.includes(p));
  if (titleHit) {
    score += SCORE_TITLE;
    reasons.push(`в назначении есть «${titleHit}»`);
  }

  return { score, reasons };
}

/**
 * Ранжирует строки выписки как кандидатов на оплату ЗАКАЗА (кнопка «Найти
 * оплату» в карточке).
 *
 * Признаки (по убыванию веса):
 * 1. сумма строки равна остатку заказа;
 * 2. брутто-совпадение: строка + комиссия, удержанная банком внутри возмещения
 *    (`parseAcquiringFee`), равны остатку — тот самый случай, когда поиск по
 *    сумме клиента не находит ничего;
 * 3. фамилия или имя клиента встречаются в контрагенте либо назначении;
 * 4. слово из названия заказа встречается в назначении.
 *
 * Строки без единого признака не возвращаются вовсе: показать «всё подряд» —
 * значит вернуть человека к тому же списку из сотен строк.
 */
export function rankPaymentCandidates<L extends PaymentCandidateLine>(
  lines: L[],
  order: PaymentMatchOrder,
): RankedPaymentCandidate<L>[] {
  const ranked: RankedPaymentCandidate<L>[] = [];
  for (const line of lines) {
    const { score, reasons } = scorePaymentPair(line, order);
    if (score > 0) ranked.push({ line, score, reasons });
  }

  return ranked.sort(
    (a, b) =>
      b.score - a.score ||
      // Детерминизм между запусками — как в transfer-match/planned-match.
      a.line.id.localeCompare(b.line.id),
  );
}

export interface OrderCandidate extends PaymentMatchOrder {
  id: string;
  /** Номер заказа для показа в подсказке. */
  number: string;
}

export interface RankedOrderCandidate<O extends OrderCandidate = OrderCandidate> {
  order: O;
  score: number;
  reasons: string[];
}

/**
 * Обратное направление: для СТРОКИ выписки ищет заказы, на оплату которых она
 * похожа («Входящие» подсказывают, куда её привязать). Признаки те же —
 * считает `scorePaymentPair`.
 */
export function rankOrderCandidates<O extends OrderCandidate>(
  orders: O[],
  line: PaymentCandidateLine,
): RankedOrderCandidate<O>[] {
  const ranked: RankedOrderCandidate<O>[] = [];
  for (const order of orders) {
    const { score, reasons } = scorePaymentPair(line, order);
    if (score > 0) ranked.push({ order, score, reasons });
  }

  return ranked.sort(
    (a, b) => b.score - a.score || a.order.id.localeCompare(b.order.id),
  );
}

// ─────────────────────────── Эффект привязки строки ───────────────────────────

export interface AttachEffectInput {
  /** Сумма строки выписки; знак не важен — сравнивается модуль. */
  lineAmount: string;
  /** Назначение платежа: из него читается удержанная комиссия эквайринга. */
  description?: string | null;
  /** Остаток по заказу: totalAmount − paidAmount. */
  remaining: string;
  /** Привязка как кредит/рассрочка — в заказ зачитывается весь остаток. */
  installment?: boolean;
}

export interface AttachEffect {
  /** Сколько зачтётся в оплату заказа. */
  credited: string;
  /** Комиссия, удержанная банком внутри строки; '0.00' — её нет. */
  fee: string;
  /** На сколько зачёт меньше остатка: заказ останется недоплаченным. */
  shortfall: string;
  /** На сколько зачёт больше остатка: переплата. */
  overpay: string;
  /** Можно ли предложить кредит/рассрочку: есть недобор и нет комиссии в назначении. */
  canInstallment: boolean;
}

/**
 * Что произойдёт с заказом, если привязать к нему эту строку выписки.
 *
 * Повторяет расчёт `InboxService.attachOrder`, чтобы UI обещал ровно то, что
 * сделает сервер: при торговом эквайринге зачитывается брутто (комиссия указана
 * внутри назначения), при рассрочке — весь остаток, иначе сумма строки.
 *
 * Нужна прежде всего ради переплаты: строку больше остатка система принимает
 * молча, и чужой платёж уже прицеплялся к заказу (Савтиков, 59 737,63) —
 * вскрылось только статусом «Переплата» при сверке. Считают оба входа —
 * «Входящие» и «Найти оплату» — одной функцией, иначе предупреждения разъедутся.
 */
export function attachEffect(input: AttachEffectInput): AttachEffect {
  const remaining = money(input.remaining);
  const amount = money(D(input.lineAmount).abs());
  const feeRaw = parseAcquiringFee(input.description);
  const fee = feeRaw ? money(feeRaw) : money(0);

  // Кредит/рассрочка и эквайринг — два способа узнать удержанное банком;
  // применённые к одной строке, они учли бы комиссию дважды (сервер такую
  // пару отклоняет), поэтому рассрочка считается только без комиссии в назначении.
  const credited = input.installment && !feeRaw ? remaining : money(amount.plus(fee));
  const diff = sub(remaining, credited);

  return {
    credited: credited.toFixed(2),
    fee: fee.toFixed(2),
    shortfall: diff.gt(0) ? diff.toFixed(2) : '0.00',
    overpay: diff.lt(0) ? diff.abs().toFixed(2) : '0.00',
    canInstallment: !feeRaw && diff.gt(0),
  };
}
