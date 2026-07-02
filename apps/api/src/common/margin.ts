import { Prisma } from '@prisma/client';

const ZERO = new Prisma.Decimal(0);

/**
 * Единое правило процента маржи: margin / revenue × 100, строкой с 2 знаками.
 *
 * revenue = 0, но есть себестоимость → маржа отрицательна: это убыток, его
 * нельзя прятать нулём. Делим на 1 (margin×100), чтобы вернуть отрицательный
 * процент-сигнал; при марже >= 0 (нет ни выручки, ни затрат) — «0.00».
 *
 * Вынесено из trade-reports/margin.service.ts: формула общая для отчёта маржи
 * и маржи в карточке заказа (orders/order-margin.ts) — расходиться им нельзя.
 */
export function marginPct(revenue: Prisma.Decimal, margin: Prisma.Decimal): string {
  if (revenue.isZero()) {
    return margin.isNegative() ? margin.times(100).toFixed(2) : ZERO.toFixed(2);
  }
  return margin.div(revenue).times(100).toFixed(2);
}
