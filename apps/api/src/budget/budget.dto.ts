import { z } from 'zod';

/** Бюджет: месячный лимит расходов / план доходов по категории. */

const Money = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, 'Сумма — число с ≤2 знаками')
  .refine((v) => Number(v) > 0, 'Сумма должна быть больше 0');

const cuid = z.string().cuid();

export const CreateBudgetSchema = z
  .object({
    categoryId: cuid,
    amount: Money,
    note: z.string().trim().max(300).nullish(),
  })
  .strict();
export type CreateBudgetDto = z.infer<typeof CreateBudgetSchema>;

export const UpdateBudgetSchema = z
  .object({
    amount: Money.optional(),
    note: z.string().trim().max(300).nullish(),
  })
  .strict();
export type UpdateBudgetDto = z.infer<typeof UpdateBudgetSchema>;

/** Месяц факта: YYYY-MM; по умолчанию — текущий бизнес-месяц. */
export const BudgetListQuerySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Месяц в формате YYYY-MM')
    .optional(),
});
export type BudgetListQuery = z.infer<typeof BudgetListQuerySchema>;
