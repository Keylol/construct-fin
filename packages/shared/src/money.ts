/**
 * Money helpers. ВАЖНО: используем строки для денег в DTO,
 * чтобы не терять точность при JSON-сериализации Decimal.
 */

import Decimal from 'decimal.js-light';

/**
 * Decimal-арифметика для фронта. Деньги в проекте НИКОГДА не проходят через
 * IEEE754 float (Number) — иначе на больших суммах теряется копейка. На бэке
 * тот же инвариант закреплён в apps/api/src/common/money.ts (Prisma.Decimal).
 * Здесь используем decimal.js-light (тот же движок, что у recharts/Prisma —
 * уже в бандле, см. recharts) и НЕ тащим Prisma.Decimal во фронт-бандл.
 *
 * Режим округления пинуем на ROUND_HALF_UP — консистентно с бэком (Блок E).
 */
Decimal.set({ rounding: Decimal.ROUND_HALF_UP });

export type Numeric = string | number | Decimal;

export const D = (v: Numeric): Decimal => new Decimal(v);
export const add = (a: Numeric, b: Numeric): Decimal => D(a).plus(D(b));
export const sub = (a: Numeric, b: Numeric): Decimal => D(a).minus(D(b));
export const mul = (a: Numeric, b: Numeric): Decimal => D(a).times(D(b));

/** Округление денег до 2 знаков (half-up). */
export const money = (v: Numeric): Decimal =>
  D(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/** Decimal → каноничная строка "1234.56" для API/расчётов (без float). */
export const toMoneyString = (v: Numeric): string => money(v).toFixed(2);

/**
 * Форматирует число/строку в "1 234 567,89 ₽" (RU). Отрицательные — в
 * бухгалтерских скобках: "(128 400,00 ₽)". (Локаль ru-RU в режиме
 * currencySign:'accounting' рисует минус, а не скобки, поэтому оборачиваем сами.)
 */
export function formatRub(value: string | number, decimals = 2): string {
  const num = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(num)) return '—';
  const abs = new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(Math.abs(num));
  return num < 0 ? `(${abs})` : abs;
}

/** Парсит "1 234,50" / "1234.5" → строка "1234.50" для отправки в API. */
export function parseAmountInput(input: string): string | null {
  const cleaned = input.replace(/\s/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  // Через Decimal, а НЕ Number().toFixed(2): на больших суммах float теряет
  // копейку (напр. "99999999999999.99" → Number даёт ...98). Регекс выше уже
  // гарантирует валидный формат с ≤2 знаками — Decimal лишь нормализует до 2.
  try {
    return toMoneyString(cleaned);
  } catch {
    return null;
  }
}
