import { z } from 'zod';

export const ClosePeriodSchema = z.object({
  year: z.number().int().min(2000).max(2100),
  month: z.number().int().min(1).max(12),
  note: z.string().max(500).nullish(),
});
export type ClosePeriodDto = z.infer<typeof ClosePeriodSchema>;

export const ReopenPeriodSchema = z.object({
  year: z.number().int().min(2000).max(2100),
  month: z.number().int().min(1).max(12),
});
export type ReopenPeriodDto = z.infer<typeof ReopenPeriodSchema>;

export const ListPeriodsQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});
export type ListPeriodsQuery = z.infer<typeof ListPeriodsQuerySchema>;
