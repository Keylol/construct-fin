import { z } from 'zod';

const MoneyString = z
  .string()
  .regex(/^-?\d+(\.\d{1,2})?$/, 'Сумма должна быть числом с ≤2 знаками');
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
  discountAmount: MoneyString.optional(),
  expectedDate: z.string().datetime().nullable().optional(),
  items: z.array(OrderItemInputSchema).default([]),
});
export type CreateOrderDto = z.infer<typeof CreateOrderSchema>;

export const UpdateOrderSchema = z.object({
  clientId: z.string().cuid().nullable().optional(),
  title: z.string().max(200).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  discountAmount: MoneyString.optional(),
  expectedDate: z.string().datetime().nullable().optional(),
  items: z.array(OrderItemInputSchema).optional(),
});
export type UpdateOrderDto = z.infer<typeof UpdateOrderSchema>;

export const ListOrdersQuerySchema = z.object({
  status: z.enum(['OPEN', 'DONE', 'CANCELLED']).optional(),
  clientId: z.string().cuid().optional(),
  search: z.string().max(100).optional(),
});
export type ListOrdersQuery = z.infer<typeof ListOrdersQuerySchema>;

export const AddPaymentSchema = z.object({
  amount: MoneyString,
  accountId: z.string().cuid(),
  date: z.string().datetime().optional(),
  description: z.string().max(500).optional(),
});
export type AddPaymentDto = z.infer<typeof AddPaymentSchema>;
