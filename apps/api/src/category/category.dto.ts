import { z } from 'zod';

const CategoryKindEnum = z.enum(['INCOME', 'EXPENSE']);

export const CreateCategorySchema = z.object({
  name: z.string().trim().min(1).max(100),
  kind: CategoryKindEnum,
  parentId: z.string().nullable().optional(),
  isFixedCost: z.boolean().optional().default(false),
});
export type CreateCategoryDto = z.infer<typeof CreateCategorySchema>;

export const UpdateCategorySchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  parentId: z.string().nullable().optional(),
  isFixedCost: z.boolean().optional(),
  isArchived: z.boolean().optional(),
});
export type UpdateCategoryDto = z.infer<typeof UpdateCategorySchema>;

export const ListCategoriesQuerySchema = z.object({
  kind: CategoryKindEnum.optional(),
  includeArchived: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => (typeof v === 'string' ? v === 'true' : Boolean(v))),
});
export type ListCategoriesQuery = z.infer<typeof ListCategoriesQuerySchema>;
