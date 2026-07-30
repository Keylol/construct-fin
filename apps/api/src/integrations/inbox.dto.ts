import { z } from 'zod';

const cuid = z.string().min(1).max(64);

export const ListInboxSchema = z.object({
  cursor: cuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  // По умолчанию — строки на разбор. AUTO_POSTED нужен, чтобы ревизовать то, что
  // правила провели сами: до этого авто-проведённое не было видно нигде.
  status: z.enum(['NEW', 'AUTO_POSTED', 'RESOLVED', 'DISMISSED']).default('NEW'),
});
export type ListInboxQuery = z.infer<typeof ListInboxSchema>;

/**
 * Массовый откат авто-проведённого: либо перечислением строк, либо целиком по
 * правилу («правило оказалось неверным — снять всё, что оно натворило»).
 */
export const UndoBulkSchema = z
  .object({
    lineIds: z.array(cuid).min(1).max(500).optional(),
    appliedRuleId: cuid.optional(),
  })
  .refine(
    (v) => (v.lineIds == null) !== (v.appliedRuleId == null),
    'нужно ровно одно: lineIds или appliedRuleId',
  );
export type UndoBulkDto = z.infer<typeof UndoBulkSchema>;

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
