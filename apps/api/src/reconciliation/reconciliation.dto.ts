import { z } from 'zod';

const moneyString = z
  .string()
  .regex(/^-?\d+(\.\d{1,2})?$/, 'must be a decimal with up to 2 fraction digits');

const isoDate = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), 'invalid ISO date');

const cuid = z.string().cuid();

/** Ввод фактического остатка счёта на дату (снимок для сверки). */
export const CreateBalanceCheckSchema = z.object({
  accountId: cuid,
  date: isoDate,
  /// Фактический остаток на счёте на указанную дату (по выписке/факту).
  actualBalance: moneyString,
  note: z.string().trim().max(500).optional(),
});
export type CreateBalanceCheckDto = z.infer<typeof CreateBalanceCheckSchema>;

/** Отчёт сверки: расчётный vs фактический по счёту на дату. */
export const ReconciliationQuerySchema = z.object({
  accountId: cuid,
  asOf: isoDate.optional(),
});
export type ReconciliationQueryDto = z.infer<typeof ReconciliationQuerySchema>;

/** Список снимков-сверок (опц. по счёту). */
export const ListChecksQuerySchema = z.object({
  accountId: cuid.optional(),
});
export type ListChecksQueryDto = z.infer<typeof ListChecksQuerySchema>;
