import { z } from 'zod';

const cuid = z.string().min(1).max(64);

export const ListInboxSchema = z.object({
  cursor: cuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListInboxQuery = z.infer<typeof ListInboxSchema>;

/** Разбор строки → проводка с выбранной категорией. */
export const CategorizeSchema = z.object({
  categoryId: cuid,
  counterpartyId: cuid.optional(),
  description: z.string().trim().max(500).optional(),
});
export type CategorizeDto = z.infer<typeof CategorizeSchema>;

/** Привязать приход к существующему заказу (оплата заказа). */
export const AttachOrderSchema = z.object({ orderId: cuid });
export type AttachOrderDto = z.infer<typeof AttachOrderSchema>;
