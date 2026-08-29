import { z } from 'zod';
import { normalizePhone } from '@construct/shared';

/**
 * Телефон клиента — видимый номер заказа (решение владельца 29.08). Принимаем
 * любую запись («+7 924 363 40 29», «89995824268»), храним канонический вид.
 */
const PhoneString = z
  .string()
  .transform((v) => normalizePhone(v))
  .refine((v): v is string => v !== null, 'Телефон должен быть российским номером');

const MoneyString = z
  .string()
  .regex(/^-?\d+(\.\d{1,2})?$/, 'Сумма должна быть числом с ≤2 знаками');
/**
 * Неотрицательные деньги (без ведущего «-»). Для скидки: отрицательная скидка
 * раздувала бы totalAmount (sub(subtotal, -X) = subtotal+X) и искажала
 * дебиторку/выручку в отчётах (дефект R5a). Отдельный тип, чтобы НЕ ужесточать
 * общий MoneyString (он нужен со знаком для сумм платежей и сторно).
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
  /**
   * Цена продажи неотрицательна: ноль допустим (позиция отдана бесплатно, напр.
   * со склада), а минус — нет. Отрицательная цена уходила в БД и падала там
   * пятисоткой вместо внятного отказа; сторно оформляется возвратом (RMA).
   */
  unitPrice: NonNegativeMoneyString,
  /// Закупочная себестоимость единицы (ручной ввод, для маржи).
  unitCost: CostString.nullable().optional(),
});
export type OrderItemInput = z.infer<typeof OrderItemInputSchema>;

export const CreateOrderSchema = z.object({
  clientId: z.string().cuid().nullable().optional(),
  /// Обязателен: по нему заказ опознаётся и группируется в списке.
  phone: PhoneString,
  title: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  discountAmount: NonNegativeMoneyString.optional(),
  expectedDate: z.string().datetime().nullable().optional(),
  items: z.array(OrderItemInputSchema).default([]),
});
export type CreateOrderDto = z.infer<typeof CreateOrderSchema>;

export const UpdateOrderSchema = z.object({
  clientId: z.string().cuid().nullable().optional(),
  phone: PhoneString.optional(),
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
  /// Ищет по номеру, названию и телефону (цифры номера, как их набирают).
  search: z.string().max(100).optional(),
  // IJ9 (drill-down «Выручка» из ОПиУ): период по дате ЗАКРЫТИЯ заказа.
  // ISO-даты; заказы без closedAt (OPEN/CANCELLED) фильтром отсеиваются.
  closedFrom: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), 'invalid ISO date')
    .optional(),
  closedTo: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), 'invalid ISO date')
    .optional(),
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

/**
 * F3 (решение #5): оплата через стороннюю рассрочку — gross, разово.
 * ORDER_PAYMENT на ПОЛНУЮ сумму + автоматический VARIABLE_COST на комиссию:
 * выручка полная, стоимость финансирования отдельно, на счёт нетто.
 */
export const InstallmentPaymentSchema = z.object({
  /// Полная сумма оплаты клиентом (вся выручка), > 0.
  amount: MoneyString,
  /// Комиссия банка рассрочки, ₽ (< amount; 0 допустим — вырожденный случай).
  fee: NonNegativeMoneyString,
  accountId: z.string().cuid(),
  date: z.string().datetime().optional(),
  description: z.string().max(500).optional(),
});
export type InstallmentPaymentDto = z.infer<typeof InstallmentPaymentSchema>;

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
/**
 * Закрытие заказа. `closedOn` — дата отгрузки: ею датируются и признание выручки
 * (`closedAt`), и проводка себестоимости. Без неё берётся текущий момент.
 * Нужна для заказов, которые заносят задним числом.
 */
// Тело целиком необязательно: закрытие без даты — штатный вызов («отгрузили
// сейчас»), и такие запросы приходят вообще без payload.
export const FinalizeOrderSchema = z
  .object({
    closedOn: z.string().datetime().optional(),
  })
  .optional()
  .default({});
export type FinalizeOrderDto = z.infer<typeof FinalizeOrderSchema>;

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
