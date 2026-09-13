import { describe, it, expect } from 'vitest';
import {
  likeContains,
  normalizeSearchText,
  parseAmountCandidates,
  parseSearchQuery,
  phoneDigitVariants,
} from '@construct/shared';

const texts = (q: string) => parseSearchQuery(q)?.tokens.map((t) => t.text);

describe('поиск: разбор запроса', () => {
  it('пусто, одни пробелы или знаки — искать нечего, а не ошибка', () => {
    for (const q of [undefined, null, '', '   ', '  ', ' — ', '₽']) {
      expect(parseSearchQuery(q), `запрос ${JSON.stringify(q)}`).toBeNull();
    }
  });

  it('регистр, «ё» и неразрывные пробелы не важны', () => {
    expect(texts('СЕМЁНОВ')).toEqual(['семенов']);
    expect(normalizeSearchText('Ёлка  Зелёная')).toBe('елка зеленая');
  });

  it('слова — отдельные токены: повторы убираются, больше восьми не ищем', () => {
    expect(texts('Иванов  аренда иванов')).toEqual(['иванов', 'аренда']);
    expect(parseSearchQuery('a b c d e f g h i j')?.tokens).toHaveLength(8);
  });

  it('сумма с пробелами разрядов и знаком рубля — один токен', () => {
    expect(texts('оплата 12 500 ₽')).toEqual(['оплата', '12 500']);
    expect(texts('1 250 000')).toEqual(['1 250 000']);
    expect(texts('66 019,00')).toEqual(['66 019,00']);
  });

  it('телефон в любой записи — один токен', () => {
    for (const q of ['8 (999) 123-45-67', '+7 999 123 45 67', '8 999 123 45 67']) {
      expect(texts(q), q).toHaveLength(1);
    }
  });

  it('«№» перед номером не мешает', () => {
    expect(texts('№ 0042')).toEqual(['0042']);
  });
});

describe('поиск: суммы в том виде, в каком их видно и набирают', () => {
  it.each([
    ['12 500', ['12500.00']],
    ['12500,00', ['12500.00']],
    ['12 500 ₽', ['12500.00']],
    ['12500.5', ['12500.50']],
    ['+500', ['500.00']],
    ['−500', ['500.00']],
    ['12,500', ['12500.00', '12.50']],
    ['12.345', ['12345.00']],
    ['1.234,56', ['1234.56']],
    ['1,234.56', ['1234.56']],
    ['1.234.567', ['1234567.00']],
    ['abc', []],
    ['0', []],
    ['8 (999) 123-45-67', []],
  ])('«%s» → %j', (q, expected) => {
    expect(parseAmountCandidates(q)).toEqual(expected);
  });
});

describe('поиск: цифры телефона и ИНН', () => {
  it('номер ищется и с 8, и с 7 — хранят его по-разному', () => {
    expect(phoneDigitVariants('8 (999) 123-45-67')).toEqual(['89991234567', '79991234567']);
    expect(phoneDigitVariants('+7 999 123 45 67')).toEqual(['79991234567', '89991234567']);
    expect(phoneDigitVariants('8 912 345')).toEqual(['8912345', '7912345']);
  });

  it('сумма «8 500» — не телефон', () => {
    expect(phoneDigitVariants('8 500')).toEqual(['8500']);
  });

  it('меньше трёх цифр и слова с буквами — без цифр', () => {
    expect(phoneDigitVariants('12')).toEqual([]);
    expect(phoneDigitVariants('rtx4090')).toEqual([]);
  });
});

describe('поиск: шаблон LIKE', () => {
  it('%, _ и ! из запроса — буквы, а не маски', () => {
    expect(likeContains('50%_!')).toBe('%50!%!_!!%');
  });
});
