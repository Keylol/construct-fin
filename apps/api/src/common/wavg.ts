import { Prisma } from '@prisma/client';
import { D, add, sub, mul, div, qty as roundQty, cost as roundCost, isZero, gt } from './money';
import type { Numeric } from './money';

/**
 * Средневзвешенная себестоимость (Weighted Average Cost).
 *
 * Чистые функции, без БД — чтобы тестировать математику изолированно.
 * Правила проекта:
 *   • Закупка (приход) меняет avgCost.
 *   • Продажа (списание) НЕ меняет avgCost — уходит по текущему среднему.
 *   • Возврат от клиента (restock) НЕ меняет avgCost — возвращаем по той же
 *     цене, по которой списали (unitCostAtSale).
 */

export interface StockState {
  qty: Prisma.Decimal;
  avgCost: Prisma.Decimal;
}

/**
 * Приход на склад: newAvg = (oldQty*oldAvg + addQty*addPrice) / (oldQty + addQty).
 * Если итоговое количество 0 (теоретически), avgCost оставляем прежним.
 */
export function applyPurchase(
  oldQty: Numeric,
  oldAvg: Numeric,
  addQty: Numeric,
  addUnitPrice: Numeric,
): StockState {
  const newQty = add(oldQty, addQty);
  if (isZero(newQty)) {
    return { qty: roundQty(newQty), avgCost: roundCost(oldAvg) };
  }
  const oldValue = mul(oldQty, oldAvg);
  const addValue = mul(addQty, addUnitPrice);
  const newAvg = div(add(oldValue, addValue), newQty);
  return { qty: roundQty(newQty), avgCost: roundCost(newAvg) };
}

/**
 * Списание при продаже. avgCost НЕ меняется. Возвращает новое количество и
 * себестоимость единицы на момент продажи (snapshot для OrderItem.unitCostAtSale).
 * Бросает, если списываем больше, чем есть (allowNegative=false).
 */
export function applySale(
  oldQty: Numeric,
  avg: Numeric,
  saleQty: Numeric,
  allowNegative = false,
): { state: StockState; unitCost: Prisma.Decimal } {
  if (!allowNegative && gt(saleQty, oldQty)) {
    throw new InsufficientStockError(D(oldQty), D(saleQty));
  }
  return {
    state: { qty: roundQty(sub(oldQty, saleQty)), avgCost: roundCost(avg) },
    unitCost: roundCost(avg),
  };
}

/**
 * Возврат товара на склад (от клиента / при отмене DONE-заказа).
 * avgCost НЕ меняется — товар возвращается по той же стоимости.
 */
export function applyReturn(oldQty: Numeric, avg: Numeric, returnQty: Numeric): StockState {
  return { qty: roundQty(add(oldQty, returnQty)), avgCost: roundCost(avg) };
}

/**
 * Возврат поставщику: снимаем количество, общую стоимость уменьшаем на сумму
 * возврата (фактический refund), avgCost пересчитываем на остаток.
 */
export function applySupplierReturn(
  oldQty: Numeric,
  oldAvg: Numeric,
  returnQty: Numeric,
  refundAmount: Numeric,
): StockState {
  const newQty = sub(oldQty, returnQty);
  if (isZero(newQty)) return { qty: roundQty(newQty), avgCost: D(0) };
  const newValue = sub(mul(oldQty, oldAvg), refundAmount);
  return { qty: roundQty(newQty), avgCost: roundCost(div(newValue, newQty)) };
}

export class InsufficientStockError extends Error {
  constructor(
    public readonly available: Prisma.Decimal,
    public readonly requested: Prisma.Decimal,
  ) {
    super(
      `Недостаточно на складе: доступно ${available.toString()}, требуется ${requested.toString()}`,
    );
    this.name = 'InsufficientStockError';
  }
}
