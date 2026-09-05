/**
 * Сопоставление позиций чека с позициями заказа.
 *
 * Спецификация и чек называют одну и ту же деталь по-разному: «Процессор:
 * Intel Core i5-12400F» против «Intel Core i5 12400F 6 ядер Процессор для ПК
 * OEM», «GIGABYTE GeForce RTX 5060 Ti WINDFORCE» против «Видеокарта PCI-E
 * Gigabyte GeForce RTX 5060TI WINDFORCE MAX 8192MB 128b». Совпадения по целой
 * строке тут не будет никогда, поэтому сравниваются слова, а решает — модель.
 *
 * Подсказка, а не автомат: каждая пара возвращается со счётом и причинами,
 * цену подставляет человек, глядя на них.
 */

export interface MatchableItem {
  /** Название позиции заказа. */
  name: string;
}

export interface MatchableReceiptLine {
  name: string;
  /** Цена за единицу, Decimal-строка. */
  unitPrice: string;
  /** Откуда строка — показывается в подсказке («ДНС», «Онлайн Трейд»). */
  source?: string;
}

export interface CostMatch {
  /** Индекс позиции заказа. */
  itemIndex: number;
  /** Индекс строки чека. */
  lineIndex: number;
  unitCost: string;
  score: number;
  reasons: string[];
}

/** Ё и регистр не должны мешать: магазины пишут как попало. */
function normalize(raw: string): string {
  return raw.toLowerCase().replace(/ё/g, 'е');
}

/**
 * Слова названия. Общие слова («видеокарта», «для», «мм») режем по длине, но
 * НЕ режем короткие модельные куски с цифрами — «ti», «v2», «m.2» решают.
 */
function tokens(raw: string): string[] {
  return normalize(raw)
    .split(/[^a-zа-я0-9.]+/i)
    .map((t) => t.replace(/^\.+|\.+$/g, ''))
    .filter((t) => t.length >= 2);
}

/**
 * Модельный токен: артикул или обозначение — «nv3000», «h610m», «ar400»,
 * «5060ti», «z3b». Такие совпадения весят больше слов вроде «память».
 */
function isModelToken(t: string): boolean {
  return /\d/.test(t) && t.length >= 3;
}

/**
 * «5060ti» и «5060 ti» — одно и то же. Слепляем соседние токены, чтобы
 * написание через пробел совпало с написанием слитно.
 */
function withGlued(list: string[]): Set<string> {
  const out = new Set(list);
  for (let i = 0; i < list.length - 1; i += 1) {
    out.add(`${list[i]}${list[i + 1]}`);
  }
  return out;
}

const STOP = new Set([
  'для', 'пк', 'шт', 'мм', 'гб', 'gb', 'тб', 'mb', 'oem', 'box', 'retail',
  'диск', 'память', 'плата', 'блок', 'питания', 'кулер', 'корпус', 'видеокарта',
  'процессора', 'процессор', 'накопитель', 'оперативная', 'основной', 'ssd',
  'черный', 'black', 'обработку', 'получению',
]);

/** Счёт пары «позиция заказа ↔ строка чека» и человеческое объяснение. */
export function scoreCostPair(
  item: MatchableItem,
  line: MatchableReceiptLine,
): { score: number; reasons: string[] } {
  const itemTokens = tokens(item.name);
  const lineSet = withGlued(tokens(line.name));

  const meaningful = itemTokens.filter((t) => !STOP.has(t));
  if (meaningful.length === 0) return { score: 0, reasons: [] };

  const hits = meaningful.filter((t) => lineSet.has(t));
  const modelHits = hits.filter(isModelToken);

  if (hits.length === 0) return { score: 0, reasons: [] };

  // Доля совпавших слов плюс вес за модель: одна «nv3000» надёжнее трёх общих слов.
  const share = hits.length / meaningful.length;
  const score = share * 100 + modelHits.length * 40;

  const reasons: string[] = [];
  if (modelHits.length > 0) reasons.push(`совпала модель: ${modelHits.join(', ')}`);
  reasons.push(`совпало слов: ${hits.length} из ${meaningful.length}`);

  return { score, reasons };
}

/**
 * Раскладывает строки чеков по позициям заказа. Одна строка — одной позиции:
 * пары берутся по убыванию счёта, занятые больше не предлагаются.
 *
 * Слабые пары отбрасываются: без модели требуется хотя бы половина слов —
 * иначе «Кулер для процессора» прилипнет к «Процессору».
 */
export function matchCostsToItems(
  items: MatchableItem[],
  lines: MatchableReceiptLine[],
): CostMatch[] {
  const pairs: CostMatch[] = [];

  items.forEach((item, itemIndex) => {
    lines.forEach((line, lineIndex) => {
      const { score, reasons } = scoreCostPair(item, line);
      if (score === 0) return;
      const hasModel = reasons.some((r) => r.startsWith('совпала модель'));
      if (!hasModel && score < 50) return;
      pairs.push({ itemIndex, lineIndex, unitCost: line.unitPrice, score, reasons });
    });
  });

  pairs.sort(
    (a, b) => b.score - a.score || a.itemIndex - b.itemIndex || a.lineIndex - b.lineIndex,
  );

  const usedItems = new Set<number>();
  const usedLines = new Set<number>();
  const out: CostMatch[] = [];
  for (const p of pairs) {
    if (usedItems.has(p.itemIndex) || usedLines.has(p.lineIndex)) continue;
    usedItems.add(p.itemIndex);
    usedLines.add(p.lineIndex);
    out.push(p);
  }

  return out.sort((a, b) => a.itemIndex - b.itemIndex);
}
