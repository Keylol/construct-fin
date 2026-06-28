import { z } from 'zod';

const RoleEnum = z.enum(['CLIENT', 'SUPPLIER', 'EMPLOYEE', 'OTHER']);
const MoneyString = z
  .string()
  .regex(/^-?\d+(\.\d{1,2})?$/, 'Сумма должна быть числом с ≤2 знаками');

// ИНН РФ: 10 цифр (юрлицо) или 12 (физлицо/ИП).
const Inn = z.string().trim().regex(/^(\d{10}|\d{12})$/, 'ИНН должен содержать 10 или 12 цифр');

export const CreateCounterpartySchema = z.object({
  name: z.string().trim().min(1).max(200),
  role: RoleEnum.optional(),
  contact: z.string().trim().max(200).optional(),
  note: z.string().trim().max(2000).optional(),
  inn: Inn.optional(),
  source: z.string().trim().max(100).optional(),
  position: z.string().trim().max(100).optional(),
  payRate: MoneyString.optional(),
});
export type CreateCounterpartyDto = z.infer<typeof CreateCounterpartySchema>;

export const UpdateCounterpartySchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  role: RoleEnum.optional(),
  contact: z.string().trim().max(200).nullable().optional(),
  note: z.string().trim().max(2000).nullable().optional(),
  inn: Inn.nullable().optional(),
  source: z.string().trim().max(100).nullable().optional(),
  position: z.string().trim().max(100).nullable().optional(),
  payRate: MoneyString.nullable().optional(),
  isArchived: z.boolean().optional(),
});
export type UpdateCounterpartyDto = z.infer<typeof UpdateCounterpartySchema>;

export const ListCounterpartiesQuerySchema = z.object({
  search: z.string().trim().min(1).optional(),
  role: RoleEnum.optional(),
  includeArchived: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => (typeof v === 'string' ? v === 'true' : Boolean(v))),
});
export type ListCounterpartiesQuery = z.infer<typeof ListCounterpartiesQuerySchema>;
