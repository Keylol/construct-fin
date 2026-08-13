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

import { D, money } from './money';
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
export function rankPaymentCandidates<L extends PaymentCandidateLine>(
  lines: L[],
  order: PaymentMatchOrder,
): RankedPaymentCandidate<L>[] {
  const remaining = money(order.remaining);
  const clientParts = nameTokens(order.clientName);
  const titleParts = significantTokens(order.title);

  const ranked: RankedPaymentCandidate<L>[] = [];
  for (const line of lines) {
    const haystack = `${normalize(line.counterpartyName)} ${normalize(line.description)}`;
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

    const clientHit = clientParts.find((p) => haystack.includes(p));
    if (clientHit) {
      score += SCORE_CLIENT;
      reasons.push('клиент упомянут в строке');
    }

    const titleHit = titleParts.find((p) => haystack.includes(p));
    if (titleHit) {
      score += SCORE_TITLE;
      reasons.push(`в назначении есть «${titleHit}»`);
    }

    if (score > 0) ranked.push({ line, score, reasons });
  }

  return ranked.sort(
    (a, b) =>
      b.score - a.score ||
      // Детерминизм между запусками — как в transfer-match/planned-match.
      a.line.id.localeCompare(b.line.id),
  );
}
