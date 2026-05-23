import { z } from 'zod';

export const CreateCounterpartySchema = z.object({
  name: z.string().trim().min(1).max(200),
  contact: z.string().trim().max(200).optional(),
  note: z.string().trim().max(2000).optional(),
});
export type CreateCounterpartyDto = z.infer<typeof CreateCounterpartySchema>;

export const UpdateCounterpartySchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  contact: z.string().trim().max(200).nullable().optional(),
  note: z.string().trim().max(2000).nullable().optional(),
  isArchived: z.boolean().optional(),
});
export type UpdateCounterpartyDto = z.infer<typeof UpdateCounterpartySchema>;

export const ListCounterpartiesQuerySchema = z.object({
  search: z.string().trim().min(1).optional(),
  includeArchived: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => (typeof v === 'string' ? v === 'true' : Boolean(v))),
});
export type ListCounterpartiesQuery = z.infer<typeof ListCounterpartiesQuerySchema>;
