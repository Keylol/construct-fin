import { Prisma } from '@prisma/client';
import { parseDate } from '../import/parsers/values';

// pdf-parse v1 имеет баг: index.js пытается читать тестовый файл при импорте.
// Берём внутренний модуль напрямую (тот же приём, что import/parsers/wb-pdf.ts).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require('pdf-parse/lib/pdf-parse.js') as (
  buffer: Buffer,
) => Promise<{ text: string; numpages: number }>;

/**
 * Детерминированный парсер кассового чека Wildberries (receipt.wb.ru, PDF с
 * текстовым слоем — OCR не нужен). Формат снят с реальных чеков
 * (fixtures/imports/wb-receipt-{1,2,3}.pdf):
 *
 *   Кассовый чек / Приход / ООО "РВБ" / … / 2026-05-21 03:25 / Чек No1471
 *   NoНаименованиеЦена, / RUB / Кол.Сумма, RUB      ← якорь начала позиций
 *   1Jungle Leopard ARGB Вентилятор 120мм           ← <№><имя…> склеены
 *   Transwarp REVERSE Aluminum Edge                 ← продолжение имени
 *   eA9.6b30292….0.0                                ← код <хэш WB-заказа>.<поз>.<штука>
 *   590.001590.00                                   ← цена+кол-во+сумма СКЛЕЕНЫ
 *   НДС 22% | Без НДС / Товар/Полный расчёт / ПОВЕРЕННЫЙ
 *   ИНН продавца 1324002440 / ООО "АЛЬЯНС МЕДИА"    ← реальный продавец строки
 *   …
 *   Итого26705.00 / Электронными26705.00 / No ФД16669 / ФПД3910731882
 *
 * На что опирается разбор:
 *  - WB печатает КАЖДУЮ ШТУКУ отдельной строкой (кол-во 1) — одинаковые штуки
 *    группируются по коду <хэш>.<поз> (fallback: имя+цена+ИНН продавца);
 *  - склейка «590.001590.00» развязывается перебором разрезов среднего блока
 *    по инварианту цена × кол-во = сумма;
 *  - футеры страниц (…receipt.wb.ru…) вырезаются ДО разбора: блок позиции
 *    может быть разорван переносом страницы в любом месте;
 *  - «№» в текстовом слое деградирует в «No»;
 *  - номер строки склеен с именем («121stPlayer…» = поз. 12 + «1stPlayer…»),
 *    поэтому старт позиции режется по ОЖИДАЕМОМУ номеру (монотонность +1).
 */

/** Сгруппированная позиция чека (штуки WB свёрнуты в кол-во). */
export type WbReceiptItem = {
  name: string;
  /** Кол-во, Decimal-строка («6»). */
  qty: string;
  unitPrice: string;
  lineTotal: string;
  sellerInn: string | null;
  sellerName: string | null;
  /** Хэш WB-заказа из кода маркировки — позиции одного чека могут быть из разных заказов WB. */
  wbOrderHash: string | null;
  /** Исходные коды штук (форензика/отладка). */
  unitCodes: string[];
};

export type ParsedWbReceipt = {
  receiptDate: Date | null;
  checkNumber: string | null;
  /** Номер фискального документа («No ФД»). */
  fd: string | null;
  /** Фискальный признак документа — ключ идемпотентности повторной загрузки. */
  fpd: string | null;
  /** «Итого» чека. */
  totalAmount: string | null;
  /** «Электронными» (оплачено безналом). */
  paidElectronic: string | null;
  items: WbReceiptItem[];
  /**
   * Несоответствия разбора (потерянные позиции, расхождение Σ строк с «Итого»,
   * отсутствие ФПД). КОНТРАКТ для сервиса: непустые warnings показываются
   * оператору в превью, а commit разбора с ними БЛОКИРУЕТСЯ — молча внести в
   * учёт неполный чек нельзя (деньги!). Парсер остаётся чистым и не бросает.
   */
  warnings: string[];
};

const FOOTER_RX = /receipt\.wb\.ru/;
const TABLE_ANCHOR_RX = /^Кол\.Сумма, RUB$/;
const HEADER_DT_RX = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
const CHECK_NO_RX = /^Чек (?:No|№)\s*(\d+)$/;
const ITEM_CODE_RX = /^e\w{1,4}\.([0-9a-f]{16,})\.(\d+)\.(\d+)$/i;
const SUMS_SPACED_RX = /^(\d+\.\d{2})\s+(\d+)\s+(\d+\.\d{2})$/;
const SUMS_SQUISHED_RX = /^(\d+)\.(\d{2})(\d+)\.(\d{2})$/;
const VAT_RX = /^(?:НДС\s*\d+\s*%|Без НДС)$/;
const CALC_RX = /^Товар\//;
const AGENT_RX = /^ПОВЕРЕННЫЙ$/;
const SELLER_INN_RX = /^ИНН продавца\s*(\d{10,12})$/;
const TOTAL_RX = /^Итого(\d[\d\s]*(?:\.\d{2})?)$/;
const ELECTRONIC_RX = /^Электронными(\d[\d\s]*(?:\.\d{2})?)$/;
const FD_RX = /^(?:No|№)\s*ФД\s*(\d+)$/;
const FPD_RX = /^ФПД\s*(\d+)$/;

/** Штука до группировки — одна строка чека WB. */
type ReceiptUnit = {
  idx: number;
  name: string;
  unitPrice: string;
  qty: string;
  lineTotal: string;
  code: string | null;
  wbOrderHash: string | null;
  wbItemIdx: string | null;
  sellerInn: string | null;
  sellerName: string | null;
};

/**
 * Развязка склейки «цена кол-во сумма». Вариант с пробелами читается напрямую;
 * склеенный «590.001590.00» перебирает разрезы среднего блока (кол-во спереди,
 * целая часть суммы сзади) по инварианту цена × кол-во = сумма. Берётся ПЕРВОЕ
 * (минимальное по кол-ву) решение — на чеках WB кол-во каждой строки равно 1.
 */
export function splitReceiptSums(
  line: string,
): { unitPrice: string; qty: string; lineTotal: string } | null {
  const spaced = SUMS_SPACED_RX.exec(line);
  if (spaced) {
    const [, price = '', qty = '', sum = ''] = spaced;
    return { unitPrice: price, qty, lineTotal: sum };
  }
  const m = SUMS_SQUISHED_RX.exec(line);
  if (!m) return null;
  const [, aInt = '', aDec = '', mid = '', dDec = ''] = m;
  const price = new Prisma.Decimal(`${aInt}.${aDec}`);
  for (let k = 1; k < mid.length; k++) {
    const qtyS = mid.slice(0, k);
    const sumS = mid.slice(k);
    // Кол-во и целая часть суммы без ведущих нулей (цена > 0 ⇒ сумма > 0).
    if (qtyS.length > 1 && qtyS.startsWith('0')) continue;
    if (sumS.length > 1 && sumS.startsWith('0')) continue;
    const sum = new Prisma.Decimal(`${sumS}.${dDec}`);
    if (price.mul(qtyS).equals(sum)) {
      return { unitPrice: price.toFixed(2), qty: qtyS, lineTotal: sum.toFixed(2) };
    }
  }
  return null;
}

/** «Итого26705.00» → каноничная денежная строка (пробелы-тысячи вычищаются). */
function moneyFrom(raw: string): string {
  return new Prisma.Decimal(raw.replace(/\s/g, '')).toFixed(2);
}

export async function parseWbReceiptPdf(buffer: Buffer): Promise<ParsedWbReceipt> {
  const parsed = await pdfParse(buffer);
  // Футеры страниц — до разбора: перенос страницы рвёт блок позиции в любом месте.
  const lines = parsed.text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !FOOTER_RX.test(l));

  const out: ParsedWbReceipt = {
    receiptDate: null,
    checkNumber: null,
    fd: null,
    fpd: null,
    totalAmount: null,
    paidElectronic: null,
    items: [],
    warnings: [],
  };

  const units: ReceiptUnit[] = [];
  let mode: 'header' | 'items' | 'tail' = 'header';
  // Стадии сборки текущей позиции: name → sums → meta (налог/агент/продавец).
  let current: ReceiptUnit | null = null;
  let stage: 'name' | 'meta' = 'name';
  let awaitSellerName = false;
  let expectedIdx = 1;

  const finalize = () => {
    if (!current) return;
    if (current.unitPrice === '') {
      out.warnings.push(
        `Позиция ${current.idx} «${current.name.slice(0, 60)}»: не удалось прочитать цену/кол-во/сумму`,
      );
    } else {
      units.push(current);
    }
    current = null;
  };

  const isItemStart = (line: string): boolean => {
    const prefix = String(expectedIdx);
    return line.startsWith(prefix) && line.length > prefix.length;
  };

  for (const line of lines) {
    if (mode === 'header') {
      if (HEADER_DT_RX.test(line)) {
        out.receiptDate = parseDate(line);
        continue;
      }
      const checkNo = CHECK_NO_RX.exec(line);
      if (checkNo) {
        out.checkNumber = checkNo[1] ?? null;
        continue;
      }
      if (TABLE_ANCHOR_RX.test(line)) mode = 'items';
      continue;
    }

    if (mode === 'items') {
      const total = TOTAL_RX.exec(line);
      if (total) {
        finalize();
        out.totalAmount = moneyFrom(total[1] ?? '0');
        mode = 'tail';
        continue;
      }

      if (current && stage === 'name') {
        const code = ITEM_CODE_RX.exec(line);
        if (code) {
          current.code = line;
          current.wbOrderHash = code[1] ?? null;
          current.wbItemIdx = code[2] ?? null;
          continue;
        }
        const sums = splitReceiptSums(line);
        if (sums) {
          current.unitPrice = sums.unitPrice;
          current.qty = sums.qty;
          current.lineTotal = sums.lineTotal;
          stage = 'meta';
          continue;
        }
        // Код позиции ещё не встречен — это продолжение имени.
        if (!current.code) {
          current.name = current.name === '' ? line : `${current.name} ${line}`;
          continue;
        }
        // После кода, но суммы не развязались — фиксируем и не теряем строку.
        out.warnings.push(`Позиция ${current.idx}: неразобранная строка «${line.slice(0, 60)}»`);
        continue;
      }

      if (current && stage === 'meta') {
        if (VAT_RX.test(line) || CALC_RX.test(line) || AGENT_RX.test(line)) continue;
        const inn = SELLER_INN_RX.exec(line);
        if (inn) {
          current.sellerInn = inn[1] ?? null;
          awaitSellerName = true;
          continue;
        }
        // Старт следующей позиции важнее возможного имени продавца с цифровым
        // началом: структура надёжнее (номера монотонны, имя продавца — одна строка).
        if (isItemStart(line)) {
          finalize();
          // упадём в общий item-start ниже
        } else if (awaitSellerName) {
          current.sellerName = line;
          awaitSellerName = false;
          continue;
        } else {
          out.warnings.push(`Позиция ${expectedIdx - 1}: неожиданная строка «${line.slice(0, 60)}»`);
          continue;
        }
      }

      if (!current && isItemStart(line)) {
        const prefix = String(expectedIdx);
        current = {
          idx: expectedIdx,
          name: line.slice(prefix.length),
          unitPrice: '',
          qty: '',
          lineTotal: '',
          code: null,
          wbOrderHash: null,
          wbItemIdx: null,
          sellerInn: null,
          sellerName: null,
        };
        stage = 'name';
        awaitSellerName = false;
        expectedIdx++;
        continue;
      }

      if (!current) {
        out.warnings.push(`Строка вне позиций: «${line.slice(0, 60)}»`);
      }
      continue;
    }

    // mode === 'tail'
    const electronic = ELECTRONIC_RX.exec(line);
    if (electronic) {
      out.paidElectronic = moneyFrom(electronic[1] ?? '0');
      continue;
    }
    const fd = FD_RX.exec(line);
    if (fd) {
      out.fd = fd[1] ?? null;
      continue;
    }
    const fpd = FPD_RX.exec(line);
    if (fpd) {
      out.fpd = fpd[1] ?? null;
      continue;
    }
  }
  finalize();

  if (mode === 'header') {
    out.warnings.push('Не найдена таблица позиций — это не похоже на кассовый чек Wildberries');
    return out;
  }

  // Группировка штук: код <хэш>.<поз> надёжнее имени; fallback — имя+цена+ИНН.
  const groups = new Map<string, WbReceiptItem>();
  for (const u of units) {
    const key =
      u.wbOrderHash && u.wbItemIdx
        ? `code:${u.wbOrderHash}.${u.wbItemIdx}|${u.unitPrice}`
        : `name:${u.name}|${u.unitPrice}|${u.sellerInn ?? ''}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        name: u.name,
        qty: u.qty,
        unitPrice: u.unitPrice,
        lineTotal: u.lineTotal,
        sellerInn: u.sellerInn,
        sellerName: u.sellerName,
        wbOrderHash: u.wbOrderHash,
        unitCodes: u.code ? [u.code] : [],
      });
    } else {
      // qty — toString (не toFixed): счёт штук целый и мал, экспоненты у Decimal
      // не достичь, а «6» читабельнее «6.000» в превью.
      existing.qty = new Prisma.Decimal(existing.qty).add(u.qty).toString();
      existing.lineTotal = new Prisma.Decimal(existing.lineTotal).add(u.lineTotal).toFixed(2);
      if (u.code) existing.unitCodes.push(u.code);
      // Продавец мог прийти только у части штук (разрыв страницы) — добираем.
      existing.sellerInn ??= u.sellerInn;
      existing.sellerName ??= u.sellerName;
    }
  }
  out.items = Array.from(groups.values());

  if (out.items.length === 0) {
    out.warnings.push('В чеке не распознано ни одной позиции');
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
  if (!out.fpd) {
    out.warnings.push('Не найден фискальный признак (ФПД) — защита от повторной загрузки не сработает');
  }

  return out;
}
