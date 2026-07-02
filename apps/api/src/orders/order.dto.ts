import { z } from 'zod';

const MoneyString = z
  .string()
  .regex(/^-?\d+(\.\d{1,2})?$/, 'Сумма должна быть числом с ≤2 знаками');
/**
 * Неотрицательные деньги (без ведущего «-»). Для скидки: отрицательная скидка
 * раздувала бы totalAmount (sub(subtotal, -X) = subtotal+X) и искажала
 * дебиторку/выручку в отчётах (дефект R5a). Отдельный тип, чтобы НЕ ужесточать
 * общий MoneyString (он нужен со знаком для unitPrice/amount/платежей).
 */
const NonNegativeMoneyString = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, 'Сумма должна быть неотрицательным числом с ≤2 знаками');
const QtyString = z
  .string()
  .regex(/^\d+(\.\d{1,3})?$/, 'Количество должно быть числом с ≤3 знаками');

const CostString = z
  .string()
  .regex(/^\d+(\.\d{1,4})?$/, 'Себестоимость — число с ≤4 знаками');

export const OrderItemInputSchema = z.object({
  warehouseItemId: z.string().cuid().nullable().optional(),
  name: z.string().min(1).max(200),
  qty: QtyString,
  unitPrice: MoneyString,
  /// Закупочная себестоимость единицы (ручной ввод, для маржи).
  unitCost: CostString.nullable().optional(),
});
export type OrderItemInput = z.infer<typeof OrderItemInputSchema>;

export const CreateOrderSchema = z.object({
  clientId: z.string().cuid().nullable().optional(),
  title: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  discountAmount: NonNegativeMoneyString.optional(),
  expectedDate: z.string().datetime().nullable().optional(),
  items: z.array(OrderItemInputSchema).default([]),
});
export type CreateOrderDto = z.infer<typeof CreateOrderSchema>;

export const UpdateOrderSchema = z.object({
  clientId: z.string().cuid().nullable().optional(),
  title: z.string().max(200).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  discountAmount: NonNegativeMoneyString.optional(),
  expectedDate: z.string().datetime().nullable().optional(),
  items: z.array(OrderItemInputSchema).optional(),
});
export type UpdateOrderDto = z.infer<typeof UpdateOrderSchema>;

export const ListOrdersQuerySchema = z.object({
  status: z.enum(['OPEN', 'DONE', 'CANCELLED']).optional(),
  clientId: z.string().cuid().optional(),
  search: z.string().max(100).optional(),
  cursor: z.string().cuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type ListOrdersQuery = z.infer<typeof ListOrdersQuerySchema>;

export const AddPaymentSchema = z.object({
  amount: MoneyString,
  accountId: z.string().cuid(),
  date: z.string().datetime().optional(),
  description: z.string().max(500).optional(),
});
export type AddPaymentDto = z.infer<typeof AddPaymentSchema>;

/** Строка графика платежей (F2, #8a). */
export const ScheduleEntryInputSchema = z.object({
  dueDate: z.string().datetime(),
  /// Строго положительная сумма с ≤2 знаками (нулевые строки бессмысленны).
  amount: z
    .string()
    .regex(/^(?!0+(\.0{1,2})?$)\d+(\.\d{1,2})?$/, 'Сумма должна быть положительной'),
  note: z.string().trim().max(500).optional(),
});
export type ScheduleEntryInput = z.infer<typeof ScheduleEntryInputSchema>;

/** Замена графика платежей целиком; пустой массив снимает график. */
export const SetScheduleSchema = z.object({
  entries: z.array(ScheduleEntryInputSchema).max(50),
});
export type SetScheduleDto = z.infer<typeof SetScheduleSchema>;

/** Частичная отгрузка позиции открытого заказа (списывает склад сразу). */
export const ShipItemSchema = z.object({
  itemId: z.string().cuid(),
  /// Отгружаемое количество (положительное, <= qty − уже отгружено).
  qty: QtyString,
});
export type ShipItemDto = z.infer<typeof ShipItemSchema>;

/** Возврат клиента (RMA): частичный/полный возврат позиции закрытого заказа. */
export const ReturnItemSchema = z.object({
  itemId: z.string().cuid(),
  /// Возвращаемое количество (положительное, <= проданное минус уже возвращённое).
  returnQty: QtyString,
  /// Сумма возврата денег клиенту (>=0; может отличаться от qty·цена — напр. сбор).
  refundAmount: z
    .string()
    .regex(/^\d+(\.\d{1,2})?$/, 'Сумма возврата — неотрицательное число с ≤2 знаками'),
  /// Счёт, с которого возвращаются деньги клиенту.
  accountId: z.string().cuid(),
  date: z.string().datetime().optional(),
  note: z.string().max(500).optional(),
});
export type ReturnItemDto = z.infer<typeof ReturnItemSchema>;
