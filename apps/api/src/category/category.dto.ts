import { z } from 'zod';

const CategoryKindEnum = z.enum(['INCOME', 'EXPENSE']);

// Бухгалтерская группа категории — по ней строится P&L (см. pnl.service).
// Должна совпадать со значениями enum CategoryBucket в schema.prisma.
const CategoryBucketEnum = z.enum([
  'REVENUE',
  'COGS',
  'PURCHASES', // F-a (HIGH-5): был в schema.prisma, но отсутствовал в DTO →
  //              категорию закупок нельзя было создать через API (400).
  'FIXED',
  'VARIABLE',
  'TAX',
  'CAPITAL',
  'OTHER',
]);

export const CreateCategorySchema = z.object({
  name: z.string().trim().min(1).max(100),
  kind: CategoryKindEnum,
  bucket: CategoryBucketEnum.optional(),
  parentId: z.string().nullable().optional(),
  isFixedCost: z.boolean().optional().default(false),
});
export type CreateCategoryDto = z.infer<typeof CreateCategorySchema>;

export const UpdateCategorySchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  bucket: CategoryBucketEnum.optional(),
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
