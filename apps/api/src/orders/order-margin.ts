import { Prisma } from '@prisma/client';
import { marginPct } from '../common/margin';
import { mul, sub, money, D } from '../common/money';

/**
 * Маржа в карточке заказа (F1, решение #4): считается на бэкенде в Decimal,
 * фронт только рисует. Чистые функции — по образцу resolvePaymentState.
 *
 * Доменные правила (блиц 2026-07-02):
 *   • Возвраты (RMA): netQty = qty − returnedQty — карточка сходится с отчётом
 *     маржи (trade-reports/margin.service.ts, A4/I8).
 *   • Каскад себестоимости = BR1 отчёта: unitCostAtSale (факт FIFO / снапшот
 *     услуги) → unitCost (ручной ввод) → avgCost склада (ОЦЕНКА до выдачи,
 *     derived-кэш лотов) → 0 (услуга без затрат = 100% маржи, R3).
 *   • База итога заказа = totalAmount (реализация ≠ оплата): выручка заказа =
 *     Σ(netQty×unitPrice) − скидка; без возвратов это ровно totalAmount.
 *     Скидка по строкам не разносится (как в отчёте маржи).
 *   • Процент — единое правило common/margin.ts.
 *
 * Округление: строки округляются до копеек (money) для показа; итог заказа
 * считается от НЕокруглённой суммы (как Order.subtotal в create/update) — чтобы
 * «Доход» бил копейка в копейку с «Итого» (totalAmount). Из-за этого Σ строк
 * может расходиться с итогом на копейки — стандартное следствие округления,
 * как и в отчёте маржи.
 */

const ZERO = new Prisma.Decimal(0);

/** Источник себестоимости строки — для пометки «оценка» в UI. */
export type CostSource = 'actual' | 'manual' | 'estimate' | null;

/** Подмножество полей OrderItem (+ avgCost склада), достаточное для маржи. */
export interface MarginItemInput {
  qty: Prisma.Decimal;
  returnedQty: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  unitCost: Prisma.Decimal | null;
  unitCostAtSale: Prisma.Decimal | null;
  warehouseItemId: string | null;
  /** include warehouseItem { avgCost }; null/undefined для услуг. */
  warehouseItem?: { avgCost: Prisma.Decimal } | null;
}

export interface ItemMargin {
  revenue: string;
  cogs: string;
  margin: string;
  marginPct: string;
  costSource: CostSource;
}

export interface OrderMarginSummary {
  revenue: string;
  cogs: string;
  margin: string;
  marginPct: string;
  /** true — в итоге есть строка с оценочной (avgCost) себестоимостью. */
  isEstimate: boolean;
}

/** Чистое проданное кол-во (за вычетом возвратов), clamp ≥ 0 на грязные данные. */
function netQtyOf(it: MarginItemInput): Prisma.Decimal {
  return Prisma.Decimal.max(sub(it.qty, it.returnedQty), ZERO);
}

function effectiveCost(it: MarginItemInput): { cost: Prisma.Decimal; source: CostSource } {
  if (it.unitCostAtSale !== null) return { cost: it.unitCostAtSale, source: 'actual' };
  if (it.unitCost !== null) return { cost: it.unitCost, source: 'manual' };
  if (it.warehouseItemId && it.warehouseItem) {
    return { cost: it.warehouseItem.avgCost, source: 'estimate' };
  }
  return { cost: ZERO, source: null };
}

export function itemMargin(it: MarginItemInput): ItemMargin {
  const netQty = netQtyOf(it);
  const { cost, source } = effectiveCost(it);
  const revenue = money(mul(netQty, it.unitPrice));
  const cogs = money(mul(netQty, cost));
  const margin = revenue.minus(cogs);
  return {
    revenue: revenue.toFixed(2),
    cogs: cogs.toFixed(2),
    margin: margin.toFixed(2),
    marginPct: marginPct(revenue, margin),
    costSource: source,
  };
}

export function orderMargin(
  items: MarginItemInput[],
  discountAmount: Prisma.Decimal | string,
): OrderMarginSummary {
  let revenueRaw = ZERO;
  let cogsRaw = ZERO;
  let isEstimate = false;
  for (const it of items) {
    const netQty = netQtyOf(it);
    const { cost, source } = effectiveCost(it);
    revenueRaw = revenueRaw.plus(mul(netQty, it.unitPrice));
    cogsRaw = cogsRaw.plus(mul(netQty, cost));
    // Полностью возвращённая строка в итог не входит — оценкой его не пятнает.
    if (source === 'estimate' && netQty.greaterThan(ZERO)) isEstimate = true;
  }
  // clamp ≥ 0: при сильных возвратах скидка может «пересидеть» остаток выручки —
  // отрицательная выручка реализации бессмысленна.
  const revenue = money(Prisma.Decimal.max(revenueRaw.minus(D(discountAmount)), ZERO));
  const cogs = money(cogsRaw);
  const margin = revenue.minus(cogs);
  return {
    revenue: revenue.toFixed(2),
    cogs: cogs.toFixed(2),
    margin: margin.toFixed(2),
    marginPct: marginPct(revenue, margin),
    isEstimate,
  };
}
