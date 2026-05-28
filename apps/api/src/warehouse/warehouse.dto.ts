import { z } from 'zod';

export const CreateWarehouseItemSchema = z.object({
  name: z.string().trim().min(1).max(200),
  sku: z.string().trim().max(64).optional(),
  unit: z.string().trim().max(16).optional(),
  /// Начальный остаток (опционально) и его себестоимость.
  openingQty: z.string().regex(/^\d+(\.\d{1,3})?$/).optional(),
  openingCost: z.string().regex(/^\d+(\.\d{1,4})?$/).optional(),
  defaultSupplierId: z.string().cuid().nullable().optional(),
  note: z.string().trim().max(1000).optional(),
});
export type CreateWarehouseItemDto = z.infer<typeof CreateWarehouseItemSchema>;

export const UpdateWarehouseItemSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  sku: z.string().trim().max(64).nullable().optional(),
  unit: z.string().trim().max(16).optional(),
  defaultSupplierId: z.string().cuid().nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
  isArchived: z.boolean().optional(),
});
export type UpdateWarehouseItemDto = z.infer<typeof UpdateWarehouseItemSchema>;

export const ListWarehouseQuerySchema = z.object({
  search: z.string().trim().min(1).optional(),
  includeArchived: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => (typeof v === 'string' ? v === 'true' : Boolean(v))),
});
export type ListWarehouseQuery = z.infer<typeof ListWarehouseQuerySchema>;

/** Ручная корректировка остатка (инвентаризация). */
export const AdjustStockSchema = z.object({
  newQty: z.string().regex(/^\d+(\.\d{1,3})?$/),
  reason: z.string().trim().max(500).optional(),
});
export type AdjustStockDto = z.infer<typeof AdjustStockSchema>;

/** Возврат товара поставщику. Снимаем со склада, получаем деньги обратно. */
export const SupplierReturnSchema = z.object({
  qty: z.string().regex(/^\d+(\.\d{1,3})?$/),
  refundAmount: z.string().regex(/^\d+(\.\d{1,2})?$/),
  accountId: z.string().cuid(),
  supplierId: z.string().cuid().nullable().optional(),
  date: z.string().datetime({ offset: true }).optional(),
  note: z.string().trim().max(500).optional(),
});
export type SupplierReturnDto = z.infer<typeof SupplierReturnSchema>;
