import { Prisma } from '@prisma/client';

/**
 * Server-side money/qty arithmetic. Всегда через Prisma.Decimal (decimal.js под
 * капотом) — никаких float. На вход принимаем string | number | Decimal,
 * на выход — Decimal либо string (для записи в БД/ответ).
 *
 * Правило проекта: деньги в API/DTO — строки, в БД — Decimal. Конвертация в
 * number допустима только в UI для форматирования.
 */
export type Numeric = string | number | Prisma.Decimal;

export const D = (v: Numeric): Prisma.Decimal => new Prisma.Decimal(v);

export const add = (a: Numeric, b: Numeric): Prisma.Decimal => D(a).plus(D(b));
export const sub = (a: Numeric, b: Numeric): Prisma.Decimal => D(a).minus(D(b));
export const mul = (a: Numeric, b: Numeric): Prisma.Decimal => D(a).times(D(b));
export const div = (a: Numeric, b: Numeric): Prisma.Decimal => D(a).div(D(b));

export const isZero = (v: Numeric): boolean => D(v).isZero();
export const isNeg = (v: Numeric): boolean => D(v).isNegative();
export const gt = (a: Numeric, b: Numeric): boolean => D(a).greaterThan(D(b));
export const gte = (a: Numeric, b: Numeric): boolean => D(a).greaterThanOrEqualTo(D(b));
export const lt = (a: Numeric, b: Numeric): boolean => D(a).lessThan(D(b));

/** Округление денег до 2 знаков (банковское — half-up). */
export const money = (v: Numeric): Prisma.Decimal => D(v).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
/** Округление себестоимости/avgCost до 4 знаков. */
export const cost = (v: Numeric): Prisma.Decimal => D(v).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
/** Округление количества до 3 знаков. */
export const qty = (v: Numeric): Prisma.Decimal => D(v).toDecimalPlaces(3, Prisma.Decimal.ROUND_HALF_UP);

/** Decimal → строка с фикс. знаками для DTO. */
export const toMoneyString = (v: Numeric): string => money(v).toFixed(2);
