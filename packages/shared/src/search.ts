/**
 * Разбор поисковой строки — одни правила для всех списков и общего поиска.
 *
 * Ищут так, как видят на экране и как набирают: «семенов» вместо «Семёнов»,
 * «8 999 123-45-67» вместо «+79991234567», «12 500 ₽» вместо 12500.00, два
 * слова из разных полей («иванов аренда»). Запрос режется на токены; запись
 * подходит, когда каждый токен совпал хотя бы с одним её полем — как текст,
 * как цифры (телефон, ИНН) или как сумма.
 */

/** Длиннее запрос не нужен: это поиск, а не вставка документа. */
export const SEARCH_MAX_LENGTH = 200;
/** Каждый токен — ещё одно AND в запросе к базе; больше восьми слов не ищут. */
export const SEARCH_MAX_TOKENS = 8;

export interface SearchToken {
  /** Текст токена: нижний регистр, «ё» → «е», одиночные пробелы. */
  text: string;
  /** Цифры токена (от трёх) — для телефона и ИНН; у номера с 8 ещё вариант с 7. */
  digits: string[];
  /** Суммы, которые может означать токен, строками вида «12500.00». */
  amounts: string[];
}

export interface ParsedSearch {
  /** Запрос после чистки пробелов, в том регистре, в каком набран. */
  raw: string;
  tokens: SearchToken[];
}

const SPACES = /[\s    ]+/g;
const CURRENCY_WORD = /^(?:₽|р\.?|руб\.?|rub)$/;
const CURRENCY_SUFFIX = /(?:₽|руб\.?|р\.?)$/;
/** Кусок числа: цифры с разрядами, дробью, скобками и дефисами телефона. */
const NUMERIC_CHUNK = /^[+\-−(]*\d[\d().,\-−]*$/;
const LETTER = /[a-zа-яё]/;
const LETTER_OR_DIGIT = /[a-zа-яё0-9]/;

/** Текст для сравнения: регистр, «ё», неразрывные и повторные пробелы не важны. */
export function normalizeSearchText(value: string | null | undefined): string {
  return (value ?? '').replace(SPACES, ' ').trim().toLowerCase().replace(/ё/g, 'е');
}

/** Шаблон LIKE «содержит»: `%`, `_` и `!` из запроса — буквы, а не маски (ESCAPE '!'). */
export function likeContains(value: string): string {
  return `%${value.replace(/[!%_]/g, '!$&')}%`;
}

function digitCount(s: string): number {
  return s.replace(/\D/g, '').length;
}

/** Телефон начинают с 8 или +7; скобок и дефисов в суммах не бывает. */
function looksLikePhoneStart(chunk: string): boolean {
  return /^(?:8|\+?7)$/.test(chunk) || /[()\-−]/.test(chunk);
}

/**
 * Режет нормализованный запрос на токены. Соседние куски одного числа
 * склеиваются: «12 500», «1 250 000», «8 (999) 123-45-67» — это одна сумма или
 * один телефон, а не несколько слов, каждое из которых должно совпасть.
 */
function tokenize(normalized: string): string[] {
  const tokens: string[] = [];
  let number: string[] = [];
  const flush = () => {
    if (number.length > 0) tokens.push(number.join(' '));
    number = [];
  };

  for (const original of normalized.split(' ')) {
    if (CURRENCY_WORD.test(original)) {
      flush();
      continue;
    }
    let chunk = original;
    let closesNumber = false;
    const withoutCurrency = chunk.replace(CURRENCY_SUFFIX, '');
    if (withoutCurrency !== chunk && NUMERIC_CHUNK.test(withoutCurrency)) {
      chunk = withoutCurrency;
      closesNumber = true;
    }
    if (NUMERIC_CHUNK.test(chunk)) {
      const prev = number.join(' ');
      const continues =
        number.length > 0 &&
        ((/^\d{3}(?:[.,]\d{1,2})?$/.test(chunk) && /(?:^|\D)\d{1,3}$/.test(prev)) ||
          (looksLikePhoneStart(number[0]!) && digitCount(prev) < 11));
      if (!continues) flush();
      number.push(chunk);
      if (closesNumber) flush();
      continue;
    }
    flush();
    // Кусок из одной пунктуации («—», «/») ничего не ищет.
    if (LETTER_OR_DIGIT.test(chunk)) tokens.push(chunk);
  }
  flush();

  return [...new Set(tokens)].slice(0, SEARCH_MAX_TOKENS);
}

/**
 * Цифры для поиска по телефону и ИНН. Телефон заказа хранится как
 * «+7XXXXXXXXXX», а в контакте клиента — как набрали, часто с 8. Поэтому номер
 * ищется и с 8, и с 7 — но только когда это похоже на телефон (11 цифр или
 * «8 999…» / «+7 999…» от семи цифр), иначе сумма «8 500» находила бы телефоны
 * с «7500».
 */
export function phoneDigitVariants(token: string): string[] {
  if (LETTER.test(token)) return [];
  const digits = token.replace(/\D/g, '');
  if (digits.length < 3) return [];
  const phoneLike =
    /^[78]/.test(digits) &&
    (digits.length === 11 || (digits.length >= 7 && /^(?:8|\+7)[\s(\-−]/.test(token)));
  if (!phoneLike) return [digits];
  return [digits, `${digits.startsWith('8') ? '7' : '8'}${digits.slice(1)}`];
}

/**
 * Суммы, которые может означать токен: «12 500», «12500,00», «12 500 ₽»,
 * «+500», «1.234,56». «12,500» неоднозначно — это и 12 500, и 12,50: берём оба.
 * Знак не важен: суммы операций и строк выписки хранятся без минуса.
 */
export function parseAmountCandidates(token: string): string[] {
  const s = token
    .replace(CURRENCY_SUFFIX, '')
    .replace(/[\s    ()]/g, '')
    .replace(/^[+\-−]+/, '');
  if (!/^\d[\d.,]*$/.test(s)) return [];

  const readings: Array<[string, string]> = [];
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot === -1 && lastComma === -1) {
    readings.push([s, '']);
  } else if (lastDot !== -1 && lastComma !== -1) {
    // «1.234,56» и «1,234.56»: дробь — после последнего разделителя.
    const at = Math.max(lastDot, lastComma);
    readings.push([s.slice(0, at).replace(/[.,]/g, ''), s.slice(at + 1)]);
  } else {
    const parts = s.split(lastDot !== -1 ? '.' : ',');
    if (parts.length > 2) {
      // «1.234.567» — только разряды.
      if (parts.slice(1).every((p) => p.length === 3)) readings.push([parts.join(''), '']);
    } else {
      const [int, frac] = parts as [string, string];
      if (frac.length === 3) readings.push([int + frac, '']);
      readings.push([int, frac]);
    }
  }

  const out = new Set<string>();
  for (const [intPart, fracPart] of readings) {
    if (!/^\d+$/.test(intPart) || !/^\d*$/.test(fracPart)) continue;
    // Копеек два знака: «12,500» как дробь годится, только если третий знак — ноль.
    const frac = fracPart.padEnd(2, '0');
    if (frac.length > 2 && !/^0+$/.test(frac.slice(2))) continue;
    const int = intPart.replace(/^0+(?=\d)/, '');
    if (int.length > 12) continue;
    const value = `${int}.${frac.slice(0, 2)}`;
    if (value === '0.00') continue;
    out.add(value);
  }
  return [...out];
}

/**
 * Запрос → токены. `null` — искать нечего (пусто, одни пробелы или знаки):
 * список показывается целиком, а не отвечает ошибкой.
 */
export function parseSearchQuery(input: string | null | undefined): ParsedSearch | null {
  const raw = (input ?? '').replace(SPACES, ' ').trim().slice(0, SEARCH_MAX_LENGTH);
  // «№» перед номером заказа в базе не хранится.
  const normalized = normalizeSearchText(raw.replace(/№/g, ' '));
  if (!normalized) return null;
  const tokens = tokenize(normalized).map((text) => ({
    text,
    digits: phoneDigitVariants(text),
    amounts: parseAmountCandidates(text),
  }));
  return tokens.length > 0 ? { raw, tokens } : null;
}
