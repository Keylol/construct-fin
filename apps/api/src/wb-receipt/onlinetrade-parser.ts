import { Prisma } from '@prisma/client';
import { parseDate } from '../import/parsers/values';
import type { ParsedReceipt } from './receipt-types';

/**
 * Парсер страницы заказа личного кабинета ОНЛАЙН ТРЕЙД (HTML→PDF). Структура
 * нестандартная: строки таблицы и НАИМЕНОВАНИЯ печатаются в РАЗНЫХ секциях.
 *
 *  Таблица «Состав заказа»: `КодТоварКол-воЦенаСуммаON-бонусов` →
 *    `19431311 шт.22 399 ₽22 399 ₽434` (код+кол-во склеены, цена/сумма/бонус
 *    через « ₽»). Развязка код↔кол-во — по инварианту цена × кол-во = сумма.
 *  Наименования — ниже, каждое заканчивается кодом модели в скобках
 *    `…(F4-3600C18D-32GVK)`; сопоставляются со строками по порядку.
 *  `Заказ No44592569 от 30.06.2026`, итог `30 502 ₽Итого:`.
 *
 * Формат хрупкий (вёрстка ЛК) — при рассогласовании счётчиков даём warning;
 * ручная правка в мастере закрывает пробелы.
 */

const MARKER = /онлайн\s*трейд|onlinetrade\.ru/i;
const TABLE_HEADER_RX = /^Код\s*Товар\s*Кол-во/i;
const TABLE_END_RX = /^(Оплаты по заказу|Статус заказа)/i;
const ORDER_NO_RX = /Заказ\s*(?:No|№)\s*(\d+)\s*от\s*(\d{2}\.\d{2}\.\d{4})/i;
const TOTAL_RX = /(\d[\d\s ]*)\s*₽\s*Итого:/;
const FOOTER_RX = /onlinetrade\.ru|Цены и условия/i;
// Хвост строки после «шт.»: <цена> ₽<сумма> ₽<бонус>.
const ROW_TAIL_RX = /^(.+?)\s*₽\s*(.+?)\s*₽\s*(\d+)$/;

function money(raw: string): string {
  return new Prisma.Decimal(raw.replace(/[\s ]/g, '').replace(',', '.')).toFixed(2);
}

/**
 * «19431311» = код + кол-во склеены; кол-во выводим из инварианта сумма/цена.
 * `ok=false` — инвариант не сошёлся (последняя цифра взята как кол-во наугад):
 * сервис по контракту покажет warning и заблокирует commit без ручной правки —
 * молча ставить неверную себестоимость лота нельзя.
 */
function splitCodeQty(
  glued: string,
  price: Prisma.Decimal,
  sum: Prisma.Decimal,
): { code: string; qty: string; ok: boolean } {
  if (!price.isZero()) {
    const q = sum.div(price).toDecimalPlaces(3);
    if (price.mul(q).toDecimalPlaces(2).equals(sum)) {
      const qStr = q.toString();
      const digits = qStr.replace('.', '');
      // Кол-во — последние цифры склейки (обычно 1 цифра); остальное — код.
      if (glued.length > digits.length && glued.endsWith(digits)) {
        return { code: glued.slice(0, glued.length - digits.length), qty: qStr, ok: true };
      }
      return { code: glued, qty: qStr, ok: true };
    }
  }
  // Инвариант не сошёлся: последняя цифра — кол-во (наугад), помечаем ok=false.
  return { code: glued.slice(0, -1) || glued, qty: glued.slice(-1) || '1', ok: false };
}

export function parseOnlineTradeLines(lines: string[]): ParsedReceipt {
  const out: ParsedReceipt = {
    source: 'ONLINE_TRADE',
    receiptDate: null,
    docNumber: null,
    checkNumber: null,
    fd: null,
    totalAmount: null,
    items: [],
    warnings: [],
  };

  // 1. Шапка: номер заказа, дата, итог — ищем по всему тексту.
  const text = lines.join('\n');
  const orderNo = ORDER_NO_RX.exec(text);
  if (orderNo) {
    out.docNumber = orderNo[1] ?? null;
    out.checkNumber = orderNo[1] ?? null;
    out.receiptDate = parseDate(orderNo[2]);
  }
  const total = TOTAL_RX.exec(text);
  if (total) out.totalAmount = money(total[1] ?? '0');

  // 2. Строки таблицы: между заголовком и «Оплаты по заказу».
  const rows: { code: string; qty: string; unitPrice: string; lineTotal: string }[] = [];
  let inTable = false;
  let tableEndIdx = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (TABLE_HEADER_RX.test(line)) {
      inTable = true;
      continue;
    }
    if (inTable && TABLE_END_RX.test(line)) {
      tableEndIdx = i;
      break;
    }
    if (!inTable) continue;
    // Разрезаем по «шт.»: слева код+кол-во, справа цена/сумма/бонус.
    const shtMatch = /\s*шт\.\s*/.exec(line);
    if (!shtMatch || shtMatch.index === 0) continue;
    const glued = line.slice(0, shtMatch.index);
    const rest = line.slice(shtMatch.index + shtMatch[0].length); // «22 399 ₽…»
    const m = ROW_TAIL_RX.exec(rest);
    if (!/^\d/.test(glued) || !m) continue;
    const price = new Prisma.Decimal(money(m[1] ?? '0'));
    const sum = new Prisma.Decimal(money(m[2] ?? '0'));
    const { code, qty, ok } = splitCodeQty(glued, price, sum);
    if (!ok) {
      out.warnings.push(
        `Строка «${glued}»: не удалось развязать код/кол-во (цена×кол-во≠сумма) — проверьте кол-во вручную`,
      );
    }
    const unit = new Prisma.Decimal(qty).isZero() ? price : sum.div(qty).toDecimalPlaces(4);
    rows.push({ code, qty, unitPrice: unit.toString(), lineTotal: sum.toFixed(2) });
  }

  // 3. Наименования: секция после таблицы; имя копится до строки, оканчивающейся
  //    на «)» (код модели в скобках). Пропускаем чисто-числовые/служебные строки.
  const names: string[] = [];
  let nameBuf: string[] = [];
  const flush = () => {
    if (nameBuf.length === 0) return;
    names.push(nameBuf.join(' ').replace(/\s+/g, ' ').trim());
    nameBuf = [];
  };
  // Между таблицей и названиями лежит блок статусов заказа, и его строки-
  // продолжения («обработку», «счёт на оплату») неотличимы от переносов внутри
  // названия. Там, где ЛК печатает «схема проезда», это надёжная граница блока.
  const anchorIdx = lines.findIndex((l, i) => i >= tableEndIdx && /схема проезда/i.test(l));
  const namesFrom = anchorIdx === -1 ? tableEndIdx : anchorIdx + 1;

  for (let i = namesFrom; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (FOOTER_RX.test(line)) break;
    if (!/[А-Яа-яA-Za-z]/.test(line)) continue; // «596 ₽», «●●●», даты
    if (
      /^(Оплаты|Статус|Передан|Подготовлен|Формируется|Готов|Ожидайте|Отменен|Выполнен|схема|Номер транзакции|Сумма:|Заказ No|Выход|Каталог|Главная|Личный кабинет)/i.test(
        line,
      )
    ) {
      continue;
    }
    // Название закрывает код модели в скобках — но он есть не у всех товаров.
    // Без него имя склеивалось со следующим, и последняя позиция оставалась
    // безымянной («Позиция 4»). Второй признак начала: строка открывается
    // русским словом с большой буквы («Корпус», «Блок питания»), тогда как
    // перенос внутри названия идёт латиницей, цифрой или строчной буквой
    // («DDR4 (2x16GB kit)», «Bronze, ATX3.1», «черный (CVMBM2-A3)»).
    const prev = nameBuf[nameBuf.length - 1];
    const looksLikeStart = /^[А-ЯЁ][а-яё]/.test(line);
    // Хвосты статусов («Передан на» / «обработку») отфильтрованы по первому
    // слову, но их продолжения приходят отдельными строками — до первого
    // названия в буфер не набираем ничего.
    if (nameBuf.length === 0 && !looksLikeStart) continue;
    const startsNew =
      nameBuf.length > 0 &&
      looksLikeStart &&
      prev !== undefined &&
      !/[,:;-]$/.test(prev) &&
      !/\s(с|и|для|из|на|в|от|до)$/i.test(prev);
    if (startsNew) flush();
    nameBuf.push(line);
    if (/\)\s*$/.test(line)) flush();
  }
  flush();

  // 4. Сшивка строк с именами по порядку.
  rows.forEach((r, i) => {
    out.items.push({
      name: names[i] ?? `Позиция ${i + 1}`,
      qty: r.qty,
      unitPrice: r.unitPrice,
      lineTotal: r.lineTotal,
      sellerName: 'ОНЛАЙН ТРЕЙД ООО',
      sellerInn: null,
      sourceRef: r.code,
    });
  });

  if (rows.length === 0) {
    out.warnings.push('В заказе ОНЛАЙН ТРЕЙД не распознано ни одной строки');
  }
  if (names.length !== rows.length) {
    out.warnings.push(
      `Распознано ${rows.length} строк и ${names.length} наименований. Названия ` +
        `сшиваются со строками по порядку, и при расхождении счётчиков они могут ` +
        `съехать — сверьте цены с товарами глазами`,
    );
  }
  if (out.totalAmount) {
    const sum = out.items.reduce((acc, it) => acc.add(it.lineTotal), new Prisma.Decimal(0));
    if (!sum.equals(out.totalAmount)) {
      out.warnings.push(
        `Сумма позиций ${sum.toFixed(2)} не сходится с «Итого» ${out.totalAmount}`,
      );
    }
  } else {
    out.warnings.push('Не найдена строка «Итого»');
  }

  return out;
}

export const ONLINE_TRADE_MARKER = MARKER;
