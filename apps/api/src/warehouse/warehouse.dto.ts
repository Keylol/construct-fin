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

/**
 * Установка себестоимости начального остатка (корректировка оценки).
 * Только для позиций с avgCost=0 (ещё не оценённых). Деньги НЕ двигаются
 * (cash-basis: начальный остаток — не закупка). Действует на будущие продажи.
 */
export const SetItemCostSchema = z.object({
  /// Себестоимость единицы, ₽ (до 4 знаков), строго положительная.
  unitCost: z.string().regex(/^\d+(\.\d{1,4})?$/),
  reason: z.string().trim().max(500).optional(),
});
export type SetItemCostDto = z.infer<typeof SetItemCostSchema>;

/** Возврат товара поставщику (B4б). */
export const SupplierReturnSchema = z.object({
  returnQty: z.string().regex(/^\d+(\.\d{1,3})?$/),
  /// Фактическая сумма возврата (refund) от поставщика, ₽.
  refundAmount: z.string().regex(/^\d+(\.\d{1,2})?$/),
  /// Счёт, на который поступает возврат.
  accountId: z.string().cuid(),
  supplierId: z.string().cuid().nullable().optional(),
  date: z.string().datetime().optional(),
  reason: z.string().trim().max(500).optional(),
  note: z.string().trim().max(1000).optional(),
});
export type SupplierReturnDto = z.infer<typeof SupplierReturnSchema>;

// ─────────── Excel-импорт склада (B2) ───────────

/** Маппинг колонок Excel → поля WarehouseItem. */
export const WarehouseImportMappingSchema = z.object({
  name: z.string().min(1),
  qty: z.string().min(1).optional(),
  avgCost: z.string().min(1).optional(),
  unit: z.string().min(1).optional(),
  reorderPoint: z.string().min(1).optional(),
});
export type WarehouseImportMapping = z.infer<typeof WarehouseImportMappingSchema>;

/** Одна строка, готовая к коммиту (после preview + правок на клиенте). */
export const WarehouseImportRowSchema = z.object({
  name: z.string().trim().min(1).max(200),
  qty: z.string().regex(/^\d+(\.\d{1,3})?$/).optional(),
  avgCost: z.string().regex(/^\d+(\.\d{1,4})?$/).optional(),
  unit: z.string().trim().max(16).optional(),
  reorderPoint: z.string().regex(/^\d+(\.\d{1,3})?$/).optional(),
});
export type WarehouseImportRow = z.infer<typeof WarehouseImportRowSchema>;

export const WarehouseImportCommitSchema = z.object({
  rows: z.array(WarehouseImportRowSchema).min(1),
});
export type WarehouseImportCommitDto = z.infer<typeof WarehouseImportCommitSchema>;
