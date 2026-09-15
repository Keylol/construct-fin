import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { parseSearchQuery } from '@construct/shared';
import { searchCondition, searchParam, type SearchField } from './text-search';

const fields: SearchField[] = [
  { text: Prisma.sql`c.name` },
  { digits: Prisma.sql`c.contact` },
  { amount: Prisma.sql`t.amount` },
];

describe('поиск: SQL-условие', () => {
  it('каждый токен — своя группа OR, токены — через AND', () => {
    const sql = searchCondition(fields, parseSearchQuery('иванов 12 500')!);
    expect(sql.text.match(/\) AND \(/g)).toHaveLength(1);
    // Сумма сравнивается числом: без CAST текстовый параметр против numeric — ошибка.
    expect(sql.text).toContain('CAST(');
  });

  it('текст запроса уходит только параметрами, не в SQL', () => {
    const sql = searchCondition(fields, parseSearchQuery("x'; DROP TABLE users; --")!);
    expect(sql.text.toLowerCase()).not.toContain('drop');
    expect(sql.values).toContain('%drop%');
  });

  it('у слова без цифр нет условий по телефону и сумме', () => {
    const sql = searchCondition(fields, parseSearchQuery('иванов')!);
    expect(sql.text).not.toContain('regexp_replace');
    expect(sql.text).not.toContain('CAST(');
  });
});

describe('поиск: параметр запроса в DTO', () => {
  it('пустая строка и одни пробелы — без поиска, а не 400', () => {
    expect(searchParam.parse('   ')).toBeUndefined();
    expect(searchParam.parse('')).toBeUndefined();
    expect(searchParam.parse(undefined)).toBeUndefined();
  });

  it('лишние пробелы схлопываются', () => {
    expect(searchParam.parse('  иванов   аренда ')).toBe('иванов аренда');
  });
});
