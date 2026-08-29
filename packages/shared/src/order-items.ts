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
 */
const FIELD_SEPARATOR = /\t|\s*\|\s*|\s+\/\s+/;

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

    const parts = line.split(FIELD_SEPARATOR).map((p) => p.trim()).filter(Boolean);
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

    const cost = rawCost === undefined ? '' : parseAmountInput(rawCost);
    if (cost === null) {
      errors.push({ line: i + 1, text: line, reason: `не похоже на сумму: «${rawCost}»` });
      return;
    }
    const price = rawPrice === undefined ? '' : parseAmountInput(rawPrice);
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
