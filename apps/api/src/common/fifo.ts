import { Prisma } from '@prisma/client';
import { D, add, sub, mul, gt, cost } from './money';
import type { Numeric } from './money';
import { InsufficientStockError } from './wavg';

/**
 * Чистая FIFO-математика партионного склада — без БД, чтобы тестировать изолированно.
 *
 * Партии (StockLot) списываются в порядке поступления (receivedAt ASC, seq ASC).
 * `consumePlan` планирует списание по открытым лотам; `reversePlan` планирует
 * восстановление (возврат клиента / откат) по конкретным потреблениям в LIFO-порядке,
 * возвращая товар ИМЕННО в те партии, из которых он ушёл, по их СНИМОЧНОЙ себестоимости.
 *
 * Суммы тут точные (без округления) — round до 4 знаков делает вызывающий на финальном
 * снимке (unitCost движения / unitCostAtSale), чтобы не копить ошибку округления по шагам.
 */

export { InsufficientStockError };

/** Открытый лот, готовый к списанию. Список подаётся уже в FIFO-порядке. */
export interface OpenLot {
  id: string;
  qtyRemaining: Prisma.Decimal;
  unitCost: Prisma.Decimal;
}

/** Списание заданного количества с конкретного лота. */
export interface ConsumeStep {
  lotId: string;
  /** Сколько взять с лота (> 0). */
  qty: Prisma.Decimal;
  /** Снимок себестоимости лота на момент списания. */
  unitCost: Prisma.Decimal;
}

export interface ConsumePlan {
  steps: ConsumeStep[];
  /** Σ qty (== requestedQty). */
  totalQty: Prisma.Decimal;
  /** Σ qty*unitCost — точная стоимость списанного (без округления). */
  totalCost: Prisma.Decimal;
}

/**
 * Жадно списывает `requestedQty` по открытым лотам в их (FIFO) порядке.
 * Бросает {@link InsufficientStockError}, если суммарного остатка не хватает —
 * вызывающий маппит её в 400 и откатывает UoW.
 */
export function consumePlan(lots: OpenLot[], requestedQty: Numeric): ConsumePlan {
  const need0 = D(requestedQty);
  if (!gt(need0, 0)) throw new Error('consumePlan: requestedQty должно быть > 0');

  const available = lots.reduce((acc, l) => add(acc, l.qtyRemaining), D(0));
  if (gt(need0, available)) throw new InsufficientStockError(available, need0);

  const steps: ConsumeStep[] = [];
  let need = need0;
  let totalCost = D(0);
  for (const lot of lots) {
    if (!gt(need, 0)) break;
    if (!gt(lot.qtyRemaining, 0)) continue;
    const take = gt(lot.qtyRemaining, need) ? need : lot.qtyRemaining; // min(remaining, need)
    steps.push({ lotId: lot.id, qty: take, unitCost: lot.unitCost });
    totalCost = add(totalCost, mul(take, lot.unitCost));
    need = sub(need, take);
  }
  return { steps, totalQty: need0, totalCost };
}

/** CONSUME-потребление с остаточной реверсируемостью. Список подаётся в LIFO-порядке. */
export interface ReversibleConsumption {
  /** LotConsumption.id исходной CONSUME-строки. */
  id: string;
  lotId: string;
  /** qty − Σ уже реверсированного по этой строке (> 0 для реверсируемых). */
  remaining: Prisma.Decimal;
  /** Снимок себестоимости: реверс берёт цену ОТСЮДА, не из текущего lot.unitCost. */
  unitCost: Prisma.Decimal;
}

/** Восстановление заданного количества в конкретный лот по снимочной цене. */
export interface ReverseStep {
  consumptionId: string;
  lotId: string;
  /** Сколько восстановить (> 0). */
  qty: Prisma.Decimal;
  /** Снимок реверсируемой CONSUME-строки. */
  unitCost: Prisma.Decimal;
}

export interface ReversePlan {
  steps: ReverseStep[];
  totalQty: Prisma.Decimal;
  totalCost: Prisma.Decimal;
}

/**
 * Планирует восстановление `requestedQty` по реверсируемым потреблениям в их (LIFO) порядке.
 * Бросает {@link InsufficientReversibleError}, если остаточной реверсируемости не хватает —
 * это инвариантная ошибка (нельзя вернуть больше, чем было списано по этой строке заказа).
 * Случай «потреблений нет вовсе» вызывающий обрабатывает ДО вызова (fallback restock).
 */
export function reversePlan(
  consumptions: ReversibleConsumption[],
  requestedQty: Numeric,
): ReversePlan {
  const need0 = D(requestedQty);
  if (!gt(need0, 0)) throw new Error('reversePlan: requestedQty должно быть > 0');

  const available = consumptions.reduce((acc, c) => add(acc, c.remaining), D(0));
  if (gt(need0, available)) throw new InsufficientReversibleError(available, need0);

  const steps: ReverseStep[] = [];
  let need = need0;
  let totalCost = D(0);
  for (const c of consumptions) {
    if (!gt(need, 0)) break;
    if (!gt(c.remaining, 0)) continue;
    const take = gt(c.remaining, need) ? need : c.remaining; // min(remaining, need)
    steps.push({ consumptionId: c.id, lotId: c.lotId, qty: take, unitCost: c.unitCost });
    totalCost = add(totalCost, mul(take, c.unitCost));
    need = sub(need, take);
  }
  return { steps, totalQty: need0, totalCost };
}

/**
 * Взвешенная себестоимость единицы для снимка движения / unitCostAtSale:
 * totalCost / totalQty, округлённая до 4 знаков. Возвращает 0 при totalQty == 0
 * (guard деления на ноль — например, полностью распроданная позиция).
 */
export function weightedUnitCost(totalCost: Numeric, totalQty: Numeric): Prisma.Decimal {
  if (!gt(D(totalQty), 0)) return D(0);
  return cost(D(totalCost).div(D(totalQty)));
}

export class InsufficientReversibleError extends Error {
  constructor(
    public readonly available: Prisma.Decimal,
    public readonly requested: Prisma.Decimal,
  ) {
    super(
      `Недостаточно реверсируемых потреблений: доступно ${available.toString()}, требуется ${requested.toString()}`,
    );
    this.name = 'InsufficientReversibleError';
  }
}
