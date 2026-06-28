import { toMoneyString } from '../../common/money';

/**
 * Решает, является ли ЕДИНСТВЕННЫЙ разделитель данного типа (`sepChar`)
 * десятичным или разделителем тысяч.
 *
 * Правило (R4b, политика «асимметрия по локали» — согласовано):
 * - Разделитель встречается > 1 раза → точно тысячи (десятичный может быть один).
 * - ЗАПЯТАЯ один раз с ровно 3 цифрами после и «головой» группы (1–3 цифры без
 *   ведущего нуля) → разделитель ТЫСЯЧ US-формата ("1,234" = 1234). Это и был
 *   исходный баг 1000×. Запятая в иных позициях → десятичная ("1234,56", "1,5", "0,123").
 * - ТОЧКА один раз → ВСЕГДА десятичная ("1.005" = 1.01, "12.345" = 12.345). Точка
 *   как разделитель тысяч в EU всегда идёт в паре с запятой-десятичной
 *   ("1.234,56") — этот случай ловится раньше в inferDecimalSep (оба символа).
 *   Поэтому одиночную точку безопаснее и предсказуемее трактовать как десятичную.
 */
function singleSepIsDecimal(s: string, sepChar: ',' | '.'): boolean {
  const count = sepChar === ',' ? (s.match(/,/g)?.length ?? 0) : (s.match(/\./g)?.length ?? 0);
  if (count > 1) return false; // несколько одинаковых разделителей → тысячи
  // Правило «3 цифры → тысячи» применяем ТОЛЬКО к запятой (асимметрия по локали).
  if (sepChar === ',') {
    const idx = s.indexOf(sepChar);
    const before = s.slice(0, idx).replace('-', '');
    const after = s.slice(idx + 1);
    if (after.length === 3 && /^[1-9]\d{0,2}$/.test(before)) return false;
  }
  return true;
}

/**
 * Определяет десятичный разделитель строки. Возвращает ',' / '.' либо null
 * (нет десятичного разделителя — все встретившиеся `,`/`.` это тысячи).
 *
 * - Оба символа присутствуют → десятичный тот, что стоит ПОЗЖЕ
 *   ("1,234.56" → '.', "1.234,56" → ',').
 * - Только один тип → решает singleSepIsDecimal.
 */
function inferDecimalSep(s: string): ',' | '.' | null {
  const hasComma = s.includes(',');
  const hasDot = s.includes('.');
  if (hasComma && hasDot) {
    return s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.';
  }
  if (hasComma) return singleSepIsDecimal(s, ',') ? ',' : null;
  if (hasDot) return singleSepIsDecimal(s, '.') ? '.' : null;
  return null;
}

/**
 * Парсит денежную строку из импорта в каноничную "1234.56" (string | null).
 *
 * R4a: финальная конвертация идёт через Decimal-хелпер (`toMoneyString`,
 * half-up до 2 знаков), а НЕ через Number()/toFixed — деньги в проекте никогда
 * не проходят через IEEE754 float. Регекс остаётся гейтом валидности.
 * R4b: см. inferDecimalSep/singleSepIsDecimal — корректно различает запятую как
 * разделитель тысяч ("1,234" → 1234.00) и как десятичный ("1234,56" → 1234.56).
 */
export function parseAmount(raw: string | null | undefined, decimalSep?: '.' | ','): string | null {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (!s) return null;

  // Чистим валюту. Порядок важен: словесные кириллические коды снимаем ДО
  // удаления одиночной «р», иначе «руб»/«грн» развалятся. ISO-коды — это 3+
  // латинские буквы (RUB/USD/EUR); буквы в числе незначимы, удаление безопасно
  // (десятичные/тысячные разделители и минус не трогаем).
  s = s
    .replace(/грн|руб/gi, '')
    .replace(/[a-z]{3,}/gi, '')
    .replace(/[₽р₸$€£]/gi, '')
    .replace(/\s| /g, '').trim();
  if (!s) return null;

  // Если decimalSep задан явно — уважаем его (поведение для заданного sep
  // сохранено). Иначе — выводим эвристикой (может вернуть null = «нет дес.»).
  const sep = decimalSep ?? inferDecimalSep(s);

  if (sep === ',') {
    // дробь через запятую: точки — тысячи, единственная запятая — десятичная.
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (sep === '.') {
    // дробь через точку: запятые — тысячи.
    s = s.replace(/,/g, '');
  } else {
    // нет десятичного разделителя: все `,`/`.` это группировка тысяч.
    s = s.replace(/[.,]/g, '');
  }

  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;

  try {
    return toMoneyString(s); // Decimal, half-up до 2 знаков
  } catch {
    return null;
  }
}

/**
 * Собирает UTC-дату из разобранных компонентов с СТРОГОЙ валидацией: проверяет
 * диапазоны (месяц 1–12, день 1–31, время 0–23/0–59) и затем сверяет, что
 * получившаяся дата не «свалилась» в соседний месяц/год (например 31.04 → 01.05
 * или 31.13 → 01.{след.год}). При любом несоответствии возвращает null, а не
 * тихо роллит дату вперёд (иначе платёж сядет не в тот период). Возвращает Date
 * либо null.
 */
function buildUtcDate(
  year: number,
  month: number, // 1-12
  day: number, // 1-31
  hh: number,
  mm: number,
  ss: number,
): Date | null {
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  if (hh > 23 || mm > 59 || ss > 59) return null;
  const dt = new Date(Date.UTC(year, month - 1, day, hh, mm, ss));
  if (Number.isNaN(dt.getTime())) return null;
  // Защита от тихого роллинга: компоненты после нормализации должны совпасть.
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== month - 1 ||
    dt.getUTCDate() !== day
  ) {
    return null;
  }
  return dt;
}

export function parseDate(raw: string | Date | null | undefined): Date | null {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw;

  const s = String(raw).trim();
  if (!s) return null;

  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (iso) {
    const [, y, m, d, hh = '00', mm = '00', ss = '00'] = iso;
    // Формат распознан как ISO → невалидную дату возвращаем как null, НЕ роллим
    // и не падаем в нативный new Date() (там разбор неоднозначен).
    return buildUtcDate(Number(y), Number(m), Number(d), Number(hh), Number(mm), Number(ss));
  }

  const dmy = /^(\d{1,2})[.\/\-](\d{1,2})[.\/\-](\d{4}|\d{2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (dmy) {
    const ddS = dmy[1] ?? '0';
    const mmS = dmy[2] ?? '0';
    const yyS = dmy[3] ?? '0';
    const hh = dmy[4] ?? '00';
    const mm = dmy[5] ?? '00';
    const ss = dmy[6] ?? '00';
    const year = yyS.length === 2 ? 2000 + Number(yyS) : Number(yyS);
    // Первая группа трактуется как ДЕНЬ, вторая как МЕСЯЦ. При month-overflow
    // (напр. «31/13/2024») или day-overflow («32/01/2024») buildUtcDate вернёт
    // null вместо тихого роллинга вперёд.
    return buildUtcDate(year, Number(mmS), Number(ddS), Number(hh), Number(mm), Number(ss));
  }

  const fallback = new Date(s);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

const TYPE_EXPENSE_RX = /расход|expense|списан|debit|outflow|оплата|списание|покупка/i;
const TYPE_INCOME_RX = /приход|income|поступл|credit|inflow|зачислен|пополн/i;

export function detectType(raw: string | null | undefined, amount: string | null): 'INCOME' | 'EXPENSE' | null {
  if (raw) {
    if (TYPE_EXPENSE_RX.test(raw)) return 'EXPENSE';
    if (TYPE_INCOME_RX.test(raw)) return 'INCOME';
  }
  if (amount) {
    return amount.startsWith('-') ? 'EXPENSE' : 'INCOME';
  }
  return null;
}
