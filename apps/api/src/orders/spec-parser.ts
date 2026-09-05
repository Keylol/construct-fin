import JSZip from 'jszip';
import { normalizePhone } from '@construct/shared';

/**
 * Разбор спецификации CONSTRUCTPC (.docx) в черновик заказа.
 *
 * Шаблон стабилен пятый месяц, но заполняют его руками, и расхождения обычны:
 * телефон пишут то `+7 922 126 67 02`, то `89655040022`, итог называют
 * «Итого», «Стоимость» или «Цена», позиций бывает 8, 9 или больше. Поэтому
 * парсер не ищет фиксированные координаты ячеек, а читает подписи.
 *
 * Цен по позициям в спецификации нет — только общая сумма. Это не пробел
 * разбора: закупочные цены приходят из чеков, а продажные раскидывает
 * «Распределить цену продажи» в форме заказа.
 */

export interface SpecItem {
  /** «Процессор», «Видеокарта» — из подписи до двоеточия. */
  kind: string;
  /** Полное наименование комплектующего. */
  name: string;
}

export interface OrderSpecDraft {
  /** Номер заказа в шаблоне — это телефон клиента (E.164, если разобрался). */
  phone: string | null;
  /** Дата спецификации (ISO), если распозналась. */
  date: string | null;
  clientName: string | null;
  /** «ПК CONSTRUCTPC (Intel Core i5-12400F; RTX 5060 Ti)». */
  title: string | null;
  items: SpecItem[];
  /** Итог заказа, Decimal-строкой. */
  total: string | null;
  /** Что не удалось разобрать — показывается человеку, а не глотается. */
  warnings: string[];
}

const MONTHS: Record<string, number> = {
  января: 1, февраля: 2, марта: 3, апреля: 4, мая: 5, июня: 6,
  июля: 7, августа: 8, сентября: 9, октября: 10, ноября: 11, декабря: 12,
};

// ── Разбор XML документа в таблицы ────────────────────────────────────────────

const TABLE_RX = /<w:tbl>.*?<\/w:tbl>/gs;
const ROW_RX = /<w:tr[ >].*?<\/w:tr>/gs;
const CELL_RX = /<w:tc[ >].*?<\/w:tc>/gs;
const PARA_RX = /<w:p[ >].*?<\/w:p>/gs;
const TEXT_RX = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/gs;

/**
 * Текст ячейки. Word рвёт слова на куски (`ию` + `л` + `я`), поэтому куски
 * склеиваются внутри абзаца, а абзацы разделяются переносом.
 */
function cellText(xml: string): string {
  const paras = xml.match(PARA_RX) ?? [];
  return paras
    .map((p) => [...p.matchAll(TEXT_RX)].map((m) => m[1]).join(''))
    .map((t) => t.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

export function docxTables(documentXml: string): string[][][] {
  return (documentXml.match(TABLE_RX) ?? []).map((table) =>
    (table.match(ROW_RX) ?? []).map((row) =>
      (row.match(CELL_RX) ?? []).map((cell) => cellText(cell)),
    ),
  );
}

/** Абзацы документа (в порядке следования), включая лежащие вне таблиц. */
export function docxParagraphs(documentXml: string): string[] {
  return [...documentXml.matchAll(PARA_RX)]
    .map((m) => [...m[0].matchAll(TEXT_RX)].map((t) => t[1]).join('').trim())
    .filter(Boolean);
}

const SPEC_MARK = /^Техническ\S*\s+спецификаци/i;
const WARRANTY_MARK = /^Гарантийное\s+обслуживание/i;

/**
 * Часть спецификаций свёрстана абзацами, без единой таблицы: подпись и значение
 * идут соседними абзацами, позиции — списком после «Техническая спецификация:».
 * Приводим их к той же форме «таблица шапки + таблица позиций», чтобы разбор
 * дальше был общим.
 *
 * Границы обязательны: ниже «Гарантийного обслуживания» лежит текст договора,
 * и его строки вида «Условия гарантии: …» неотличимы от позиций.
 */
export function paragraphsToTables(paragraphs: string[]): string[][][] {
  const specAt = paragraphs.findIndex((p) => SPEC_MARK.test(p));
  const warrantyAt = paragraphs.findIndex((p) => WARRANTY_MARK.test(p));
  const headerEnd = specAt === -1 ? paragraphs.length : specAt;
  const bodyEnd = warrantyAt === -1 ? paragraphs.length : warrantyAt;

  const header: string[][] = [];
  for (let i = 0; i < headerEnd; i += 1) {
    const label = paragraphs[i] ?? '';
    if (label.endsWith(':') && i + 1 < headerEnd) header.push([label, paragraphs[i + 1] ?? '']);
  }

  const body = paragraphs.slice(specAt + 1, bodyEnd).map((p) => [p]);
  return [header, body];
}

// ── Разбор таблиц в черновик ─────────────────────────────────────────────────

/** Сумма вида «113 343.00 руб.» / «5 397,00 руб.» → Decimal-строка. */
function parseAmount(raw: string): string | null {
  const m = raw.match(/(\d[\d\s ]*(?:[.,]\d{1,2})?)\s*(?:руб|₽)/i);
  if (!m?.[1]) return null;
  const digits = m[1].replace(/[\s ]/g, '').replace(',', '.');
  const num = Number(digits);
  return Number.isFinite(num) ? num.toFixed(2) : null;
}

function parseSpecDate(raw: string): string | null {
  const m = raw.match(/от\s+(\d{1,2})\s+([а-яё]+)\s+(\d{4})/i);
  if (!m?.[1] || !m[2] || !m[3]) return null;
  const month = MONTHS[m[2].toLowerCase()];
  if (!month) return null;
  const day = Number(m[1]);
  const year = Number(m[3]);
  // Полдень UTC+5: дата не съезжает на сутки ни в одном поясе показа.
  return new Date(Date.UTC(year, month - 1, day, 7, 0, 0)).toISOString();
}

/** Значение по подписи: ищем ячейку «Заказчик:» и берём соседнюю справа. */
function findByLabel(rows: string[][], label: string): string | null {
  for (const row of rows) {
    const idx = row.findIndex((c) => c.toLowerCase().startsWith(label.toLowerCase()));
    const cell = idx === -1 ? undefined : row[idx];
    if (!cell) continue;
    const sameCell = cell.slice(cell.indexOf(':') + 1).trim();
    if (sameCell) return sameCell;
    const next = row.slice(idx + 1).find((c) => c.trim());
    if (next) return next.trim();
  }
  return null;
}

export function parseSpecTables(tables: string[][][]): OrderSpecDraft {
  const warnings: string[] = [];
  const header = tables[0] ?? [];

  const orderNo = findByLabel(header, 'Заказ №');
  // «+7 922 126 67 02 от 28 июля 2026г.» — номер и дата в одной строке. Пробел
  // перед «от» ставят не всегда: «89103995527От 18 января 2026 г.» — четверть файлов.
  // Второй номер через «/» встречается, когда заказ оформляли на родственника —
  // в номер заказа идёт первый.
  const phoneRaw = orderNo
    ? ((orderNo.split(/\s*от\s+/i)[0] ?? '').split('/')[0] ?? '').trim()
    : null;
  const phone = phoneRaw ? normalizePhone(phoneRaw) : null;
  if (phoneRaw && !phone) warnings.push(`Номер заказа «${phoneRaw}» не похож на телефон`);
  if (!orderNo) warnings.push('В шапке нет строки «Заказ №»');

  const date = orderNo ? parseSpecDate(orderNo) : null;
  if (orderNo && !date) warnings.push('Не удалось разобрать дату из шапки');

  // «Архипов Константин Сергеевич (С)» — буква в скобках это пометка магазина.
  const clientRaw = findByLabel(header, 'Заказчик');
  const clientName = clientRaw ? clientRaw.replace(/\s*\([^)]*\)\s*$/, '').trim() : null;
  if (!clientName) warnings.push('В шапке нет строки «Заказчик»');

  const title = findByLabel(header, 'Наименование');
  if (!title) warnings.push('В шапке нет строки «Наименование»');

  // Позиции и суммы живут в таблицах после шапки: у одних спецификаций всё в
  // одной таблице, у других сборка и услуги разнесены.
  const items: SpecItem[] = [];
  const amounts: { label: string; value: string }[] = [];

  for (const rows of tables.slice(1)) {
    for (const row of rows) {
      const text = row.map((c) => c.trim()).filter(Boolean).join(' ');
      if (!text) continue;

      const totalHit = text.match(/^(Итого|Стоимость|Цена)\s*:/i);
      if (totalHit?.[1]) {
        const value = parseAmount(text);
        if (value) amounts.push({ label: totalHit[1].toLowerCase(), value });
        continue;
      }

      // Строка позиции: «Процессор: Intel Core i5-12400F». Служебные строки
      // («Дополнительно», «Тестирование») тоже с двоеточием, но они не товар —
      // отсекаем по списку известных подписей.
      const item = text.match(/^(?:\d+\s+)?([А-ЯЁA-Z][^:]{2,40}):\s*(.+)$/s);
      if (!item?.[1] || !item[2]) continue;
      const kind = item[1].trim();
      const name = item[2].replace(/\s+/g, ' ').trim();
      if (/^(дополнительно|тестирование|настройка|гарантия|срок|примечание)/i.test(kind)) continue;
      if (!name) continue;
      items.push({ kind, name });
    }
  }

  if (items.length === 0) warnings.push('Не найдено ни одной позиции спецификации');

  // «Итого» перекрывает частные суммы; без него складываем «Цена»/«Стоимость»
  // (сборка + услуги идут двумя строками).
  const explicit = amounts.find((a) => a.label === 'итого');
  let total: string | null = null;
  if (explicit) {
    total = explicit.value;
  } else if (amounts.length > 0) {
    total = amounts
      .reduce((acc, a) => acc + Number(a.value), 0)
      .toFixed(2);
  } else {
    warnings.push('Не найден итог заказа');
  }

  return { phone, date, clientName, title, items, total, warnings };
}

/** Полный разбор файла: .docx — это zip, нужен только word/document.xml. */
export async function parseOrderSpecDocx(file: Buffer): Promise<OrderSpecDraft> {
  const zip = await JSZip.loadAsync(file);
  const doc = zip.file('word/document.xml');
  if (!doc) {
    throw new Error('Файл не похож на .docx: внутри нет word/document.xml');
  }
  const xml = await doc.async('string');
  const tables = docxTables(xml);
  // Без таблиц шаблон не «пустой», а другой — собираем таблицы из абзацев.
  return parseSpecTables(tables.length > 0 ? tables : paragraphsToTables(docxParagraphs(xml)));
}
