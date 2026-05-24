import { z } from 'zod';

export const CreateCategoryRuleSchema = z.object({
  keyword: z.string().trim().min(1).max(200),
  categoryId: z.string().min(1),
  priority: z.number().int().min(0).max(1000).optional(),
  isActive: z.boolean().optional(),
});
export type CreateCategoryRuleDto = z.infer<typeof CreateCategoryRuleSchema>;

export const UpdateCategoryRuleSchema = z.object({
  keyword: z.string().trim().min(1).max(200).optional(),
  categoryId: z.string().min(1).optional(),
  priority: z.number().int().min(0).max(1000).optional(),
  isActive: z.boolean().optional(),
});
export type UpdateCategoryRuleDto = z.infer<typeof UpdateCategoryRuleSchema>;

export const ListCategoryRulesQuerySchema = z.object({
  includeInactive: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => (typeof v === 'string' ? v === 'true' : Boolean(v))),
});
export type ListCategoryRulesQuery = z.infer<typeof ListCategoryRulesQuerySchema>;
