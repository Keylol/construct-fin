import { z } from 'zod';

const TxTypeEnum = z.enum(['INCOME', 'EXPENSE']);

const moneyString = z
  .string()
  .regex(/^-?\d+(\.\d{1,2})?$/, 'must be a decimal with up to 2 fraction digits');

const isoDate = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), 'invalid ISO date');

const cuid = z.string().min(1).max(64);

export const CreateTransactionSchema = z.object({
  date: isoDate,
  amount: moneyString,
  type: TxTypeEnum,
  accountId: cuid,
  categoryId: cuid.nullable().optional(),
  counterpartyId: cuid.nullable().optional(),
  description: z.string().trim().max(500).optional(),
});
export type CreateTransactionDto = z.infer<typeof CreateTransactionSchema>;

export const UpdateTransactionSchema = z.object({
  date: isoDate.optional(),
  amount: moneyString.optional(),
  type: TxTypeEnum.optional(),
  accountId: cuid.optional(),
  categoryId: cuid.nullable().optional(),
  counterpartyId: cuid.nullable().optional(),
  description: z.string().trim().max(500).nullable().optional(),
});
export type UpdateTransactionDto = z.infer<typeof UpdateTransactionSchema>;

export const ListTransactionsQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  accountId: cuid.optional(),
  categoryId: cuid.optional(),
  counterpartyId: cuid.optional(),
  type: TxTypeEnum.optional(),
  minAmount: moneyString.optional(),
  maxAmount: moneyString.optional(),
  search: z.string().trim().min(1).optional(),
  cursor: cuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListTransactionsQuery = z.infer<typeof ListTransactionsQuerySchema>;

export const TransactionSummaryQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
});
export type TransactionSummaryQuery = z.infer<typeof TransactionSummaryQuerySchema>;
