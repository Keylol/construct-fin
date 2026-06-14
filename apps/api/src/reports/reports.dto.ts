import { z } from 'zod';

export const PeriodPresetSchema = z.enum([
  'this-month',
  'prev-month',
  'this-quarter',
  'prev-quarter',
  'this-year',
  'prev-year',
  'ytd',
  'last-30d',
  'last-90d',
  'last-12m',
]);

export const CompareModeSchema = z.enum(['none', 'prev', 'yoy', 'custom']);

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}(T.*)?$/);

export const PnlQuerySchema = z
  .object({
    preset: PeriodPresetSchema.optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    groupBy: z.enum(['month', 'quarter']).default('month'),
    compareWith: CompareModeSchema.default('none'),
    compareFrom: isoDate.optional(),
    compareTo: isoDate.optional(),
  })
  .strict();
export type PnlQuery = z.infer<typeof PnlQuerySchema>;

export const CashflowQuerySchema = z
  .object({
    preset: PeriodPresetSchema.optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    accountId: z.string().min(1).optional(),
    // consolidated (по умолчанию): единый пул всех счетов, внутренние переводы
    // гасятся. byAccount: серия на каждый счёт, переводы видны как движения.
    mode: z.enum(['consolidated', 'byAccount']).default('consolidated'),
  })
  .strict();
export type CashflowQuery = z.infer<typeof CashflowQuerySchema>;

export const BreakdownQuerySchema = z
  .object({
    preset: PeriodPresetSchema.optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    type: z.enum(['INCOME', 'EXPENSE', 'ALL']).default('EXPENSE'),
  })
  .strict();
export type BreakdownQuery = z.infer<typeof BreakdownQuerySchema>;

export const ExportFormatSchema = z.enum(['csv', 'xlsx']);
export type ExportFormat = z.infer<typeof ExportFormatSchema>;
