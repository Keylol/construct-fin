import { z } from 'zod';

const AccountTypeEnum = z.enum(['CASH', 'BANK', 'OTHER']);

// Класс счёта определяет роль в денежном потоке (Волна 0):
//  OPERATING — рабочий счёт бизнеса; TRANSIT — эквайринг/маркетплейс/посредник;
//  PERSONAL — личный счёт физика, через который проходят деньги бизнеса.
const AccountClassEnum = z.enum(['OPERATING', 'TRANSIT', 'PERSONAL']);

// money: строка "1234.56" (две цифры после точки), либо без точки
const moneyString = z
  .string()
  .regex(/^-?\d+(\.\d{1,2})?$/, 'must be a decimal with up to 2 fraction digits');

export const CreateAccountSchema = z.object({
  name: z.string().trim().min(1).max(100),
  type: AccountTypeEnum,
  class: AccountClassEnum.optional().default('OPERATING'),
  openingBalance: moneyString.optional().default('0'),
  note: z.string().trim().max(500).optional(),
});
export type CreateAccountDto = z.infer<typeof CreateAccountSchema>;

export const UpdateAccountSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  type: AccountTypeEnum.optional(),
  class: AccountClassEnum.optional(),
  openingBalance: moneyString.optional(),
  note: z.string().trim().max(500).nullable().optional(),
  isArchived: z.boolean().optional(),
});
export type UpdateAccountDto = z.infer<typeof UpdateAccountSchema>;

export const ListAccountsQuerySchema = z.object({
  includeArchived: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => (typeof v === 'string' ? v === 'true' : Boolean(v))),
});
export type ListAccountsQuery = z.infer<typeof ListAccountsQuerySchema>;
