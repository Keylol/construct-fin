import { z } from 'zod';

// #11: регэкспы допускают «0»/«0.00». Закупка нулевого кол-ва или по нулевой
// цене бессмысленна (порча WAVG/себестоимости), поэтому требуем строго > 0.
const Money = z
  .string()
  .regex(/^\d+(\.\d{1,4})?$/, 'Цена — число с ≤4 знаками')
  .refine((v) => Number(v) > 0, 'Цена должна быть больше 0');
const Qty = z
  .string()
  .regex(/^\d+(\.\d{1,3})?$/, 'Кол-во — число с ≤3 знаками')
  .refine((v) => Number(v) > 0, 'Кол-во должно быть больше 0');

export const PurchaseLineInputSchema = z.object({
  warehouseItemId: z.string().cuid(),
  qty: Qty,
  unitPrice: Money,
});
export type PurchaseLineInput = z.infer<typeof PurchaseLineInputSchema>;

export const CreatePurchaseSchema = z.object({
  accountId: z.string().cuid(),
  supplierId: z.string().cuid().nullable().optional(),
  date: z.string().datetime().optional(),
  note: z.string().trim().max(500).optional(),
  lines: z.array(PurchaseLineInputSchema).min(1, 'Добавьте хотя бы одну позицию'),
});
export type CreatePurchaseDto = z.infer<typeof CreatePurchaseSchema>;

export const ListPurchasesQuerySchema = z.object({
  supplierId: z.string().cuid().optional(),
});
export type ListPurchasesQuery = z.infer<typeof ListPurchasesQuerySchema>;
