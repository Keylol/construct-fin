/**
 * Состав заказа текстом и распределение цены продажи.
 *
 * Сборка из восьми комплектующих — это 26 полей ручного ввода: название, цена
 * продажи и закупка на каждую позицию. Спецификация при этом уже существует
 * списком (docx поставщика, заметка, выгрузка) — не хватало только способа
 * перенести её целиком, а не по клетке.
 *
 * Второй кусок ручной работы — цены продажи. Клиент платит одну сумму за сборку,
 * а в заказе она должна лечь по позициям: иначе маржа считается только по заказу
 * целиком и не видно, на чём заработали. Раскладка «пропорционально закупке»
 * повторяет то, что владелец считал в калькуляторе на каждом заказе июля.
 */

import Decimal from 'decimal.js-light';
import { D, money, toMoneyString, parseAmountInput } from './money';
import { normalizePhone } from './phone';

export interface ParsedOrderItem {
  name: string;
  /** Количество; целое или с ≤3 знаками, как требует API. */
  qty: string;
  /** Закупочная цена за единицу, Decimal-строка; пусто, если в тексте её не было. */
  unitCost: string;
  /** Цена продажи за единицу; пусто — заполняется распределением. */
  unitPrice: string;
}

export interface ParseOrderItemsResult {
  items: ParsedOrderItem[];
  /** Строки, которые разобрать не удалось: 1-based номер и причина. */
  errors: { line: number; text: string; reason: string }[];
}

/**
 * Разделитель полей. Табуляция первым делом — вставка из таблицы; `|` и `/`
 * набирают руками. Точку с запятой не берём: она встречается внутри названий
 * («ПК CONSTRUCTPC (Ryzen 7; RTX 5080)»).
 *
 * Хвостовые пробелы в разделитель НЕ входят (`\s+\/` с проверкой пробела
 * впереди): иначе «Кулер /  / 1200» — обычная запись «закупка неизвестна» —
 * съедалась целиком, поля съезжали и строка уходила в ошибку.
 */
const FIELD_SEPARATOR = /\t|\s*\|\s*|\s+\/(?=\s|$)/;

/**
 * Количество в хвосте названия: «Вентилятор 120мм ×4», «Планка DDR5 x2».
 * Требуем пробел перед множителем, иначе «RTX 5080 x16» (разъём) читалось бы
 * как 16 видеокарт.
 */
const QTY_SUFFIX = /\s+[x×хХ]\s*(\d{1,3})$/iu;

function splitQty(raw: string): { name: string; qty: string } {
  const match = QTY_SUFFIX.exec(raw);
  if (!match?.[1]) return { name: raw, qty: '1' };
  const qty = Number(match[1]);
  if (!Number.isFinite(qty) || qty < 1) return { name: raw, qty: '1' };
  return { name: raw.slice(0, match.index).trim(), qty: String(qty) };
}

/**
 * Разбирает состав заказа из текста: строка на позицию, поля
 * `название [/ закупка [/ продажа]]`.
 *
 * Нераспознанные строки НЕ выбрасываются молча — возвращаются в `errors`, чтобы
 * форма показала их человеку. Молчаливая потеря строки здесь означала бы заказ
 * с недостающей позицией и заниженной себестоимостью.
 */
export function parseOrderItemsText(text: string): ParseOrderItemsResult {
  const items: ParsedOrderItem[] = [];
  const errors: ParseOrderItemsResult['errors'] = [];

  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;

    // Пустые части НЕ выбрасываем: «Кулер /  / 1200» значит «цена закупки
    // неизвестна, продажа 1200». Выброс сдвинул бы продажу в закупку.
    const parts = line.split(FIELD_SEPARATOR).map((p) => p.trim());
    const [rawName, rawCost, rawPrice] = parts;
    if (!rawName) {
      errors.push({ line: i + 1, text: line, reason: 'пустое название' });
      return;
    }

    const { name, qty } = splitQty(rawName);
    if (!name) {
      errors.push({ line: i + 1, text: line, reason: 'пустое название' });
      return;
    }

    const cost = rawCost === undefined || rawCost === '' ? '' : parseAmountInput(rawCost);
    if (cost === null) {
      errors.push({ line: i + 1, text: line, reason: `не похоже на сумму: «${rawCost}»` });
      return;
    }
    const price = rawPrice === undefined || rawPrice === '' ? '' : parseAmountInput(rawPrice);
    if (price === null) {
      errors.push({ line: i + 1, text: line, reason: `не похоже на сумму: «${rawPrice}»` });
      return;
    }

    items.push({ name, qty, unitCost: cost, unitPrice: price });
  });

  return { items, errors };
}

/**
 * Раскидывает итог заказа по позициям пропорционально их закупочной стоимости
 * (закупка × количество).
 *
 * Возвращает цену ЗА ЕДИНИЦУ по каждой позиции — именно её хранит API. Последняя
 * позиция добирает остаток: при делении на три и больше частей копейки не
 * сходятся, и без добора сумма позиций расходится с тем, что заплатил клиент.
 *
 * Точное схождение гарантируется, когда у добирающей позиции количество 1 —
 * типовой случай сборки. При дробном или кратном количестве цена за единицу
 * округляется до копейки, и сумма может разойтись с итогом на величину до
 * 0,01 × qty; форма показывает фактическую сумму позиций рядом с итогом, так что
 * расхождение видно, а не спрятано.
 *
 * Вырожденный случай: суммарная закупка нулевая (услуги, товар со склада без
 * цены) — делим поровну, другой опоры нет.
 */
export function allocateSalePrices(
  items: { qty: string; unitCost: string }[],
  total: string,
): string[] {
  if (items.length === 0) return [];

  const target = money(total);
  const weights = items.map((it) => D(it.qty || '0').times(D(it.unitCost || '0')));
  const weightSum = weights.reduce((a, b) => a.plus(b), D(0));
  const even = weightSum.isZero();

  /**
   * Доли всех позиций, кроме добирающей, округляем ВНИЗ. Half-up здесь дал бы
   * сумму больше итога, и добирающей позиции доставался бы отрицательный
   * остаток: на живом заказе (9 позиций, последняя без закупки) получилось
   * −0,01 ₽, и сервер отвечал 500 вместо внятной ошибки.
   */
  const floorMoney = (v: Decimal): Decimal => v.toDecimalPlaces(2, Decimal.ROUND_DOWN);

  // Количество 0 валидатор заказа не пропустит, но делить на него всё равно
  // нельзя — такая позиция получает свою долю целиком как цену за единицу.
  const perUnit = (sum: Decimal, qtyRaw: string): Decimal => {
    const qty = D(qtyRaw || '0');
    return qty.isZero() ? sum : sum.dividedBy(qty);
  };

  const prices: string[] = [];
  let allocated = D(0);
  items.forEach((it, i) => {
    if (i === items.length - 1) {
      // Клэмп в ноль — страховка на случай, если позиций больше, чем копеек в
      // итоге, и округление вниз всё равно не оставило остатка.
      const rest = target.minus(allocated);
      const left = rest.isNegative() ? D(0) : rest;
      prices.push(toMoneyString(perUnit(left, it.qty)));
      return;
    }
    const share = even
      ? target.dividedBy(items.length)
      : target.times(weights[i] ?? D(0)).dividedBy(weightSum);
    const price = floorMoney(perUnit(share, it.qty));
    // Копим фактически разнесённое (цена × количество), а не идеальную долю:
    // иначе округление каждой строки утекло бы мимо добора.
    allocated = allocated.plus(price.times(D(it.qty || '0')));
    prices.push(toMoneyString(price));
  });

  return prices;
}

// ── Заказ целиком из текста ──────────────────────────────────────────────────

export interface ParsedOrderDraft {
  phone: string | null;
  clientName: string | null;
  title: string | null;
  /** Дата заказа (ISO), если распозналась. */
  date: string | null;
  /** Итог заказа Decimal-строкой — для распределения цены продажи. */
  total: string | null;
  items: ParsedOrderItem[];
  errors: ParseOrderItemsResult['errors'];
}

const MONTHS: Record<string, number> = {
  января: 1, февраля: 2, марта: 3, апреля: 4, мая: 5, июня: 6,
  июля: 7, августа: 8, сентября: 9, октября: 10, ноября: 11, декабря: 12,
};

/** Подписи шапки: то же, что печатает спецификация CONSTRUCTPC. */
const HEAD_LABELS: { key: 'order' | 'client' | 'title' | 'total'; rx: RegExp }[] = [
  { key: 'order', rx: /^(?:заказ\s*№|телефон)\s*:?\s*/i },
  { key: 'client', rx: /^(?:заказчик|клиент|фио)\s*:?\s*/i },
  { key: 'title', rx: /^(?:наименование|название)\s*:?\s*/i },
  { key: 'total', rx: /^(?:итого|стоимость|цена)\s*:?\s*/i },
];

/**
 * Сумма из строки шапки: «122 868.00 руб.», «Итого 122868», «113 343,00 ₽».
 * Отдельно от `parseAmountInput` — тот принимает только чистое число, а здесь
 * рядом всегда стоит слово или знак валюты.
 */
function parseHeadAmount(raw: string): string | null {
  const m = raw.match(/-?\d[\d\s\u00a0\u202f]*(?:[.,]\d{1,2})?/);
  return m ? parseAmountInput(m[0]) : null;
}

/** Дата словом («от 14 июня 2026г.») или цифрами («от 14.06.2026»). */
function parseDraftDate(raw: string): string | null {
  const word = raw.match(/(\d{1,2})\s+([а-яё]+)\s+(\d{4})/i);
  if (word?.[1] && word[2] && word[3]) {
    const month = MONTHS[word[2].toLowerCase()];
    if (month) {
      // Полдень UTC+5 — дата не съезжает на сутки ни в одном поясе показа.
      return new Date(Date.UTC(+word[3], month - 1, +word[1], 7, 0, 0)).toISOString();
    }
  }
  const digits = raw.match(/(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})/);
  if (digits?.[1] && digits[2] && digits[3]) {
    return new Date(Date.UTC(+digits[3], +digits[2] - 1, +digits[1], 7, 0, 0)).toISOString();
  }
  return null;
}

/**
 * Заказ целиком из текста: шапка (телефон, заказчик, название, итог) плюс
 * позиции. Формат — тот же, что человек видит в спецификации CONSTRUCTPC,
 * поэтому её можно скопировать как есть, не раскладывая по полям формы.
 *
 * Строки без подписи считаются позициями и разбираются `parseOrderItemsText`:
 * «название / закупка / продажа». Так одна вставка заменяет пять действий —
 * телефон, имя, название, состав и итог для распределения.
 */
export function parseOrderDraftText(text: string): ParsedOrderDraft {
  const head: Record<string, string> = {};
  const itemLines: string[] = [];

  text.split(/\r?\n/).forEach((raw) => {
    const line = raw.trim();
    if (!line) return;
    const hit = HEAD_LABELS.find((l) => l.rx.test(line));
    // Подпись без значения («Итого:» и сумма следующей строкой) шапкой не
    // считается — иначе она молча съела бы следующую позицию.
    if (hit) {
      const value = line.replace(hit.rx, '').trim();
      if (value && head[hit.key] === undefined) {
        head[hit.key] = value;
        return;
      }
      if (!value) return;
    }
    itemLines.push(line);
  });

  const orderLine = head.order ?? '';
  // «+7 922 126 67 02 от 28 июля 2026г.» — номер и дата одной строкой; пробел
  // перед «от» ставят не всегда.
  const phoneRaw = (orderLine.split(/\s*от\s+/i)[0] ?? '').split('/')[0]?.trim() ?? '';
  const parsed = parseOrderItemsText(itemLines.join('\n'));

  return {
    phone: phoneRaw ? normalizePhone(phoneRaw) : null,
    clientName: head.client ? head.client.replace(/\s*\([^)]*\)\s*$/, '').trim() : null,
    title: head.title ?? null,
    date: orderLine ? parseDraftDate(orderLine) : null,
    total: head.total ? parseHeadAmount(head.total) : null,
    items: parsed.items,
    errors: parsed.errors,
  };
}
