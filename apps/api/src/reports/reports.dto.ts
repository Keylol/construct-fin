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

// Дата (или дата-время) ISO. Регэксп ограничивает месяц 01-12 и день 01-31, а
// .refine отбраковывает несуществующие даты (2026-02-30, 2026-04-31): строим
// UTC-дату из Y-M-D и сверяем, что компоненты не «переехали» при нормализации.
export const isoDate = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(T.*)?$/)
  .refine((s) => {
    const parts = s.slice(0, 10).split('-');
    const y = Number(parts[0]);
    const m = Number(parts[1]);
    const d = Number(parts[2]);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return (
      dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
    );
  }, 'invalid calendar date');

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

export const BreakevenQuerySchema = z
  .object({
    preset: PeriodPresetSchema.optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
  })
  .strict();
export type BreakevenQuery = z.infer<typeof BreakevenQuerySchema>;

export const ExportFormatSchema = z.enum(['csv', 'xlsx']);
export type ExportFormat = z.infer<typeof ExportFormatSchema>;
