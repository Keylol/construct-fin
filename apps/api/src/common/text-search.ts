import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import {
  SEARCH_MAX_LENGTH,
  likeContains,
  type ParsedSearch,
  type SearchToken,
} from '@construct/shared';

/**
 * Общий поиск по спискам: одни правила вместо пяти самописных `contains`.
 *
 * Запрос разбирает `parseSearchQuery` (packages/shared/src/search.ts), здесь —
 * SQL. Совпавшие id находит один сырой запрос, а сервис добавляет
 * `id: { in: ids }` в свой обычный Prisma-`where`: сортировка, курсор и
 * остальные фильтры не меняются.
 *
 * Почему сырой SQL: Prisma `contains` не складывает «ё» с «е», не умеет искать
 * по цифрам телефона и по суммам и не экранирует `%` и `_` из запроса.
 */

/**
 * Параметр поиска в DTO списков: пробелы схлопываются, пустая строка и одни
 * пробелы значат «без поиска». Раньше `trim().min(1)` отвечал на пробел 400, и
 * экран показывал ошибку вместо полного списка.
 */
export const searchParam = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  const s = value.replace(/\s+/g, ' ').trim().slice(0, SEARCH_MAX_LENGTH);
  return s === '' ? undefined : s;
}, z.string().optional());

// Нижний регистр кириллицы явно, а не только lower(): так поиск не зависит от
// локали базы. «Ё» и «ё» складываются в «е» — как в normalizeSearchText.
const UPPER = 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯё';
const LOWER = 'абвгдеежзийклмнопрстуфхцчшщъыьэюяе';

/** Колонка в том же виде, что нормализованный запрос: нижний регистр, «ё» → «е». */
export function normalizedColumn(column: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`translate(lower(coalesce(${column}, '')), ${UPPER}, ${LOWER})`;
}

/** Колонка содержит текст токена. */
export function textContains(column: Prisma.Sql, token: SearchToken): Prisma.Sql {
  return Prisma.sql`${normalizedColumn(column)} LIKE ${likeContains(token.text)} ESCAPE '!'`;
}

/** Цифры колонки (телефон «+7 (999) …», ИНН) содержат цифры токена. */
export function digitsContain(column: Prisma.Sql, token: SearchToken): Prisma.Sql | null {
  if (token.digits.length === 0) return null;
  const digits = Prisma.sql`regexp_replace(coalesce(${column}, ''), '[^0-9]', '', 'g')`;
  return Prisma.join(
    token.digits.map((d) => Prisma.sql`${digits} LIKE ${likeContains(d)} ESCAPE '!'`),
    ' OR ',
  );
}

/** Сумма колонки равна одной из сумм токена. CAST обязателен: параметр приходит текстом. */
export function amountIn(column: Prisma.Sql, token: SearchToken): Prisma.Sql | null {
  if (token.amounts.length === 0) return null;
  const values = token.amounts.map((a) => Prisma.sql`CAST(${a} AS numeric)`);
  return Prisma.sql`${column} IN (${Prisma.join(values)})`;
}

export type SearchField =
  | { text: Prisma.Sql }
  | { digits: Prisma.Sql }
  | { amount: Prisma.Sql }
  /** Условие по связанным строкам (позиции заказа, оплаты) — `EXISTS (…)`. */
  | { custom: (token: SearchToken) => Prisma.Sql | null };

export interface SearchSpec {
  /** FROM с JOIN'ами связанных таблиц. */
  from: Prisma.Sql;
  /** id основной таблицы. */
  id: Prisma.Sql;
  /** Обязательные условия: организация, не удалено. */
  where: Prisma.Sql;
  fields: SearchField[];
}

function fieldCondition(field: SearchField, token: SearchToken): Prisma.Sql | null {
  if ('text' in field) return textContains(field.text, token);
  if ('digits' in field) return digitsContain(field.digits, token);
  if ('amount' in field) return amountIn(field.amount, token);
  return field.custom(token);
}

/** Каждый токен совпал хотя бы с одним полем: AND по токенам из OR по полям. */
export function searchCondition(fields: SearchField[], search: ParsedSearch): Prisma.Sql {
  const perToken = search.tokens.map((token) => {
    const any = fields
      .map((field) => fieldCondition(field, token))
      .filter((c): c is Prisma.Sql => c !== null);
    return any.length > 0 ? Prisma.sql`(${Prisma.join(any, ' OR ')})` : Prisma.sql`FALSE`;
  });
  return Prisma.join(perToken, ' AND ');
}

/**
 * Потолок совпавших id. В организации тысячи строк, а не сотни тысяч; упор в
 * потолок значит, что запрос ни о чём («а», «1») — показываем первые.
 */
export const SEARCH_ID_CAP = 10_000;

/** id записей, подходящих под запрос. Порядок не гарантирован — сортирует вызывающий. */
export async function findSearchIds(
  db: Pick<PrismaClient, '$queryRaw'>,
  spec: SearchSpec,
  search: ParsedSearch,
): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    SELECT DISTINCT ${spec.id} AS id
    FROM ${spec.from}
    WHERE ${spec.where} AND ${searchCondition(spec.fields, search)}
    LIMIT ${SEARCH_ID_CAP}`;
  return rows.map((r) => r.id);
}
