import { z } from 'zod';

const Money = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, 'Сумма — число с ≤2 знаками')
  .refine((v) => Number(v) > 0, 'Сумма должна быть больше 0');

export const TaxYearQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
});
export type TaxYearQuery = z.infer<typeof TaxYearQuerySchema>;

export const TaxPayBodySchema = z.object({
  year: z.number().int().min(2000).max(2100),
  month: z.number().int().min(1).max(12),
  accountId: z.string().cuid(),
  amount: Money,
  date: z.string().datetime().optional(),
  note: z.string().trim().max(300).nullish(),
});
export type TaxPayBody = z.infer<typeof TaxPayBodySchema>;

export const TaxAusnBodySchema = z.object({
  transactionId: z.string().cuid(),
  /** null — снять переопределение (вернуть авто-разбор по kind). */
  ausnMark: z.enum(['INCOME', 'EXPENSE', 'NOT_COUNTED']).nullable(),
});
export type TaxAusnBody = z.infer<typeof TaxAusnBodySchema>;
