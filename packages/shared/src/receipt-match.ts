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
 * Характеристика, а не модель: «16гб», «8g», «750w», «5600мгц», «2280».
 * Объём и частота совпадают у совершенно разных товаров, и вес модели им не
 * положен — иначе «16Гб Patriot Viper Venom» цепляется к любой строке с «16гб».
 */
const SPEC_TOKEN = /^\d+(?:[.,]\d+)?(?:гб|gb|тб|tb|мб|mb|гц|hz|мгц|mhz|w|вт|v|мм|mm|dpi|шт)?$/;

/**
 * Модельный токен: артикул или обозначение — «nv3000», «h610m», «ar400»,
 * «5060ti», «z3b». Такие совпадения весят больше слов вроде «память».
 */
function isModelToken(t: string): boolean {
  return /\d/.test(t) && t.length >= 3 && !SPEC_TOKEN.test(t);
}

/**
 * Слова, различающие соседние модели одной линейки: «5060» и «5060 Ti» —
 * разные видеокарты с разницей в цене под пять тысяч, и в сводном чеке они
 * лежат рядом. Одностороннее наличие такого слова означает, что товар не тот.
 *
 * Список нарочно короткий. «MAX», «PLUS», «LITE» бывают частью полного имени
 * («WINDFORCE MAX OC» в чеке против «WINDFORCE» в спецификации) и как признак
 * различия дают ложные отказы — проверено на живых архивах.
 */
const DISCRIMINATORS = new Set(['ti', 'super', 'xt', 'xtx']);

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
  const lineTokens = tokens(line.name);
  const lineSet = withGlued(lineTokens);

  const meaningful = itemTokens.filter((t) => !STOP.has(t));
  if (meaningful.length === 0) return { score: 0, reasons: [] };

  const hits = meaningful.filter((t) => lineSet.has(t));
  const modelHits = hits.filter(isModelToken);

  if (hits.length === 0) return { score: 0, reasons: [] };

  // Доля совпавших слов плюс вес за модель: одна «nv3000» надёжнее трёх общих слов.
  const share = hits.length / meaningful.length;
  let score = share * 100 + modelHits.length * 40;

  const reasons: string[] = [];
  if (modelHits.length > 0) reasons.push(`совпала модель: ${modelHits.join(', ')}`);
  reasons.push(`совпало слов: ${hits.length} из ${meaningful.length}`);

  // Различающее слово есть с одной стороны — товар другой. Штраф перебивает вес
  // модели: без него «RTX 5060» и «RTX 5060 Ti» из одного чека неразличимы.
  // Пишут и слитно («5060TI»), поэтому ищем ещё и внутри модельных токенов.
  const carries = (list: string[], d: string): boolean =>
    list.includes(d) || list.some((t) => t.length > d.length && t.endsWith(d) && /\d/.test(t));
  const missed = [...DISCRIMINATORS].filter(
    (d) => carries(itemTokens, d) !== carries(lineTokens, d),
  );
  if (missed.length > 0) {
    score -= missed.length * 60;
    reasons.push(`не сходится: ${missed.join(', ')}`);
  }

  return { score: Math.max(score, 0), reasons };
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
      const hasModel =
        reasons.some((r) => r.startsWith('совпала модель')) &&
        !reasons.some((r) => r.startsWith('не сходится'));
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

export interface ApplicableItem extends MatchableItem {
  /** Количество в позиции заказа, Decimal-строка. */
  qty: string;
  /** Уже введённая руками закупка — её не перетираем. */
  unitCost: string;
}

export interface ApplicableLine extends MatchableReceiptLine {
  /** Количество в строке чека: три вентилятора по 590 — это 1 770 себестоимости. */
  qty: string;
}

export interface CostApplication {
  itemIndex: number;
  /** Цена за единицу из чека. */
  unitCost: string;
  /** Количество из чека — подставляется, только когда в позиции стояла единица. */
  qty: string;
  /** false — цену не ставим: в позиции уже есть своя. */
  applied: boolean;
  reasons: string[];
}

export interface CostPlan {
  applications: CostApplication[];
  /** Индексы строк чека, не легших ни на одну позицию. */
  unusedLineIndexes: number[];
}

/**
 * План подстановки закупочных цен: что и почему встанет в позиции заказа.
 *
 * Отдельно от `matchCostsToItems`, потому что решает не «похоже ли», а «что
 * делаем»: количество из чека переносится, только если в позиции стоит единица
 * (иначе человек уже указал своё), а позиции с введённой руками закупкой
 * остаются нетронутыми — и это видно в отчёте, а не молча.
 */
export function planCostApplication(
  items: ApplicableItem[],
  lines: ApplicableLine[],
): CostPlan {
  const matches = matchCostsToItems(items, lines);
  const used = new Set<number>();

  const applications = matches.map((m) => {
    const item = items[m.itemIndex];
    const line = lines[m.lineIndex];
    const applied = !item?.unitCost;
    if (applied) used.add(m.lineIndex);
    // Количество из чека берём, только когда в позиции единица: спецификация
    // пишет «Вентиляторы: 3 шт.» одной строкой, а чек — тремя штуками в строке.
    const lineQty = Number(line?.qty ?? '1');
    const keepQty = !item || Number(item.qty) !== 1 || !Number.isFinite(lineQty) || lineQty <= 1;
    return {
      itemIndex: m.itemIndex,
      unitCost: m.unitCost,
      qty: keepQty ? (item?.qty ?? '1') : String(lineQty),
      applied,
      reasons: applied ? m.reasons : [...m.reasons, 'закупка уже заполнена — не меняем'],
    };
  });

  const unusedLineIndexes = lines.map((_, i) => i).filter((i) => !used.has(i));
  return { applications, unusedLineIndexes };
}
