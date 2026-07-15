import { Prisma } from '@prisma/client';
import { parseDate } from '../import/parsers/values';
import type { ParsedReceipt, ParsedReceiptItem } from './receipt-types';

/**
 * Парсер документов ДНС («ООО ДНС Ритейл»). Два формата с одним детектором:
 *
 *  A. КАССОВЫЙ ЧЕК (fiscal): имя (многострочное) → `1 шт. x 21 599.0021 599.00`
 *     (кол-во шт. x цена+сумма склеены) → `Код товара5653309` → `ИТОГ=…` /
 *     `ФД No…` / `ФП…`.
 *  B. Товарный заказ (`Заказ No 6Б-…`): таблица со СКИДКОЙ,
 *     `<№+код>` → имя → `38999.0010.0038999.00` (цена+кол-во+скидка+сумма
 *     склеены, 4 поля) → `ИТОГО…р.`.
 *
 * Разбор денег — детерминированный по инварианту цена × кол-во = сумма (скидка
 * информационна: авторитетна сумма строки, unitPrice = сумма/кол-во).
 */

const SELLER_INN = '2540167061'; // ИНН ООО «ДНС Ритейл» (константа для трассы строки)

// Формат A (кассовый чек).
const FISCAL_MARKER = /КАССОВЫЙ ЧЕК/i;
const FISCAL_CHECK_NO_RX = /^КАССОВЫЙ ЧЕК\s*(?:No|№)\s*(\d+)/i;
const FISCAL_DATE_RX = /^Продажа\s*(\d{2}\.\d{2}\.\d{4})/;
const FISCAL_QTYLINE_RX = /^(\d+(?:[.,]\d+)?)\s*шт\.\s*x\s*(\d[\d\s]*\.\d{2})(\d[\d\s]*\.\d{2})$/;
const FISCAL_CODE_RX = /^Код товара\s*(\d+)/;
const FISCAL_TOTAL_RX = /^ИТОГ\s*=\s*(\d[\d\s]*\.\d{2})/;
const FISCAL_FD_RX = /^ФД\s*(?:No|№)?\s*(\d+)/;
const FISCAL_FP_RX = /^ФП\s*(\d+)/;
// Строки-атрибуты предмета расчёта между суммой и кодом (пропускаем).
const FISCAL_ATTR_RX = /^(?:Ставка НДС|Признак|Мера кол|Акциз|Код страны|Номер ГТД)/;

// Формат B (товарный заказ).
const ORDER_MARKER = /Заказ\s*(?:No|№)\s*6[ББ]/i; // «6Б-…» (Б кириллическая)
const ORDER_NO_RX = /Заказ\s*(?:No|№)\s*(6[Б]-?\d+)\s*от\s*(\d{2}\.\d{2}\.\d{4})/i;
const ORDER_HEADER_RX = /^(?:No)?КодНаименование/;
const ORDER_TOTAL_RX = /^ИТОГО\s*(\d[\d\s ]*,\d{2})\s*р\./;
const ORDER_SUMLINE_RX = /^Сумма\s*:/;
// Строка сумм товарного заказа: цена+кол-во+скидка+сумма склеены =
// (\d+\.\d{2})(\d+)(\d+\.\d{2})(\d+\.\d{2}) → цена, кол-во, скидка, сумма.
// Три десятичные группы (цена/скидка/сумма) + целое кол-во между ценой и скидкой.
const ORDER_AMOUNTS_RX = /^(\d+\.\d{2})(\d+)(\d+\.\d{2})(\d+\.\d{2})$/;

/** «21 599.00» / «38 999,00» → каноничная Decimal-строка. */
function money(raw: string): string {
  return new Prisma.Decimal(raw.replace(/[\s ]/g, '').replace(',', '.')).toFixed(2);
}

/** Инвариант цена × кол-во = сумма для развязки склеенных числовых полей. */
function qtyFromInvariant(price: Prisma.Decimal, sum: Prisma.Decimal): string | null {
  if (price.isZero()) return null;
  const q = sum.div(price);
  // Кол-во ДНС всегда целое; допускаем дробное до 3 знаков как fallback.
  const rounded = q.toDecimalPlaces(3);
  if (!price.mul(rounded).toDecimalPlaces(2).equals(sum)) return null;
  return rounded.toString();
}

function parseDnsFiscal(lines: string[]): ParsedReceipt {
  const out: ParsedReceipt = {
    source: 'DNS',
    receiptDate: null,
    docNumber: null,
    checkNumber: null,
    fd: null,
    totalAmount: null,
    items: [],
    warnings: [],
  };

  const nameBuf: string[] = [];
  let pending: { name: string; qty: string; unitPrice: string; lineTotal: string } | null = null;

  for (const line of lines) {
    const checkNo = FISCAL_CHECK_NO_RX.exec(line);
    if (checkNo) {
      out.checkNumber = checkNo[1] ?? null;
      continue;
    }
    const date = FISCAL_DATE_RX.exec(line);
    if (date) {
      out.receiptDate = parseDate(date[1]);
      continue;
    }
    const total = FISCAL_TOTAL_RX.exec(line);
    if (total) {
      out.totalAmount = money(total[1] ?? '0');
      continue;
    }
    const fd = FISCAL_FD_RX.exec(line);
    if (fd) {
      out.fd = fd[1] ?? null;
      // ФД как fallback-ключ дедупа, если ФП не встретится.
      out.docNumber ??= fd[1] ?? null;
      continue;
    }
    const fp = FISCAL_FP_RX.exec(line);
    if (fp) {
      out.docNumber = fp[1] ?? null; // ФП — самый устойчивый ключ документа
      continue;
    }

    const qtyLine = FISCAL_QTYLINE_RX.exec(line);
    if (qtyLine) {
      const qty = (qtyLine[1] ?? '1').replace(',', '.');
      const price = new Prisma.Decimal(money(qtyLine[2] ?? '0'));
      const sum = new Prisma.Decimal(money(qtyLine[3] ?? '0'));
      const name = nameBuf.join(' ').trim();
      nameBuf.length = 0;
      // unitPrice = сумма/кол-во (сумма авторитетна). Инвариант — мягкая сверка.
      const unit = new Prisma.Decimal(qty).isZero()
        ? price
        : sum.div(qty).toDecimalPlaces(4);
      pending = {
        name: name || 'Позиция ДНС',
        qty,
        unitPrice: unit.toString(),
        lineTotal: sum.toFixed(2),
      };
      if (!price.mul(qty).toDecimalPlaces(2).equals(sum)) {
        out.warnings.push(`ДНС: «${name.slice(0, 40)}» — цена×кол-во ≠ сумма (скидка?)`);
      }
      continue;
    }

    const code = FISCAL_CODE_RX.exec(line);
    if (code && pending) {
      out.items.push({
        name: pending.name,
        qty: pending.qty,
        unitPrice: pending.unitPrice,
        lineTotal: pending.lineTotal,
        sellerName: 'ООО "ДНС Ритейл"',
        sellerInn: SELLER_INN,
        sourceRef: code[1] ?? null,
      });
      pending = null;
      continue;
    }

    if (FISCAL_ATTR_RX.test(line)) continue;
    // Прочие строки шапки/подвала — часть имени только ДО строки сумм.
    if (!pending && !FISCAL_MARKER.test(line) && !/^(Продажа|Смена|Сайт|Электронный|Телефон|Применяемая|Признак расчет|Место расчёт|ИНН|Общество|\d{6},)/.test(line)) {
      nameBuf.push(line);
    }
  }

  // Позиция без «Код товара» в хвосте — всё равно фиксируем (код опционален).
  if (pending) {
    out.items.push({
      name: pending.name,
      qty: pending.qty,
      unitPrice: pending.unitPrice,
      lineTotal: pending.lineTotal,
      sellerName: 'ООО "ДНС Ритейл"',
      sellerInn: SELLER_INN,
      sourceRef: null,
    });
  }

  finalize(out);
  return out;
}

function parseDnsOrder(lines: string[]): ParsedReceipt {
  const out: ParsedReceipt = {
    source: 'DNS',
    receiptDate: null,
    docNumber: null,
    checkNumber: null,
    fd: null,
    totalAmount: null,
    items: [],
    warnings: [],
  };

  let inItems = false;
  const nameBuf: string[] = [];

  for (const raw of lines) {
    const orderNo = ORDER_NO_RX.exec(raw);
    if (orderNo) {
      out.docNumber = (orderNo[1] ?? '').replace(/\s/g, '');
      out.checkNumber = out.docNumber;
      out.receiptDate = parseDate(orderNo[2]);
      continue;
    }
    if (ORDER_HEADER_RX.test(raw)) {
      inItems = true;
      continue;
    }
    const total = ORDER_TOTAL_RX.exec(raw);
    if (total) {
      out.totalAmount = money(total[1] ?? '0');
      inItems = false;
      continue;
    }
    if (!inItems) continue;
    if (ORDER_SUMLINE_RX.test(raw)) {
      // «Сумма:38 999,00р.» — промежуточный итог, имя не копим.
      nameBuf.length = 0;
      continue;
    }

    const amounts = ORDER_AMOUNTS_RX.exec(raw);
    if (amounts && !/[А-Яа-яA-Za-z]/.test(raw)) {
      const price = new Prisma.Decimal(money(amounts[1] ?? '0'));
      const sum = new Prisma.Decimal(money(amounts[4] ?? '0'));
      // amounts[2] = кол-во, amounts[3] = скидка (информационна: авторитетна
      // сумма). Инвариант — приоритетный источник кол-ва, regex — fallback.
      const qty = qtyFromInvariant(price, sum) ?? amounts[2] ?? '1';
      const name = nameBuf.join(' ').trim();
      nameBuf.length = 0;
      const unit = new Prisma.Decimal(qty).isZero()
        ? price
        : sum.div(qty).toDecimalPlaces(4);
      out.items.push({
        name: name.replace(/^\d+/, '').trim() || 'Позиция ДНС',
        qty,
        unitPrice: unit.toString(),
        lineTotal: sum.toFixed(2),
        sellerName: 'ООО "ДНС Ритейл"',
        sellerInn: SELLER_INN,
        sourceRef: null,
      });
      continue;
    }
    // Строка имени (первая обычно «<№><код>», № срежется выше по regex).
    nameBuf.push(raw);
  }

  finalize(out);
  return out;
}

/** Общие пост-проверки: непустота, сверка Σ с итогом, наличие ключа. */
function finalize(out: ParsedReceipt): void {
  if (out.items.length === 0) {
    out.warnings.push('В документе ДНС не распознано ни одной позиции');
  }
  if (out.totalAmount) {
    const sum = out.items.reduce(
      (acc, it) => acc.add(it.lineTotal),
      new Prisma.Decimal(0),
    );
    if (!sum.equals(out.totalAmount)) {
      out.warnings.push(
        `Сумма позиций ${sum.toFixed(2)} не сходится с «Итого» ${out.totalAmount}`,
      );
    }
  } else {
    out.warnings.push('Не найдена строка «Итого»');
  }
}

export function parseDnsLines(lines: string[]): ParsedReceipt {
  const text = lines.join('\n');
  if (FISCAL_MARKER.test(text)) return parseDnsFiscal(lines);
  return parseDnsOrder(lines);
}

export const DNS_MARKERS = { FISCAL_MARKER, ORDER_MARKER };
export type { ParsedReceiptItem };
