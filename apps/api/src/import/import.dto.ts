import { z } from 'zod';

const ImportSourceSchema = z.enum([
  'GENERIC_CSV',
  'GENERIC_XLSX',
  'ALFA_XLSX',
  'TINKOFF_PDF',
  'WB_PDF',
]);

const ColumnMappingSchema = z
  .object({
    date: z.string().min(1),
    amount: z.string().min(1),
    type: z.string().optional(),
    description: z.string().optional(),
    counterparty: z.string().optional(),
    amountDecimalSeparator: z.enum(['.', ',']).optional(),
  })
  .strict();

export const PreviewQuerySchema = z.object({
  accountId: z.string().min(1),
  source: ImportSourceSchema.optional(),
  mapping: z.string().optional(),
});
export type PreviewQuery = z.infer<typeof PreviewQuerySchema>;

export const CommitRowSchema = z
  .object({
    date: z.string().min(8),
    amount: z.string().regex(/^\d+(\.\d{1,2})?$/),
    type: z.enum(['INCOME', 'EXPENSE']),
    description: z.string().nullable(),
    counterpartyName: z.string().nullable(),
    categoryId: z.string().nullable(),
    /// F3 (5d): привязка строки к заказу — строка станет ORDER_PAYMENT.
    orderId: z.string().cuid().nullable().optional(),
    importHash: z.string().min(1),
    isDuplicate: z.boolean(),
  })
  .strict();
export type CommitRow = z.infer<typeof CommitRowSchema>;

export const CommitBodySchema = z
  .object({
    filename: z.string().min(1),
    fileHash: z.string().min(1),
    source: ImportSourceSchema,
    accountId: z.string().min(1),
    skipDuplicates: z.boolean().default(true),
    rows: z.array(CommitRowSchema).min(1),
  })
  .strict();
export type CommitBody = z.infer<typeof CommitBodySchema>;

export { ColumnMappingSchema, ImportSourceSchema };
