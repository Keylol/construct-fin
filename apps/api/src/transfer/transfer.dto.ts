import { z } from 'zod';
import { isoDate } from '../common/iso-date';

const moneyString = z
  .string()
  .regex(/^-?\d+(\.\d{1,2})?$/, 'must be a decimal with up to 2 fraction digits');

const cuid = z.string().cuid();

export const CreateTransferSchema = z
  .object({
    fromAccountId: cuid,
    toAccountId: cuid,
    /// Переводимая сумма (поступает на счёт-получатель).
    amount: moneyString,
    /// Комиссия за перевод (реальный расход на счёте-источнике сверх amount).
    fee: moneyString.optional().default('0'),
    date: isoDate,
    note: z.string().trim().max(500).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.fromAccountId === val.toAccountId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toAccountId'],
        message: 'fromAccountId и toAccountId должны различаться',
      });
    }
  });
export type CreateTransferDto = z.infer<typeof CreateTransferSchema>;
