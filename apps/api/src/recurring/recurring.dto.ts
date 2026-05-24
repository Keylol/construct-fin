import { z } from 'zod';

export const FrequencySchema = z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']);
export type Frequency = z.infer<typeof FrequencySchema>;

export const TemplateSchema = z
  .object({
    amount: z.string().regex(/^\d+(\.\d{1,2})?$/, 'amount must be Decimal string'),
    type: z.enum(['INCOME', 'EXPENSE']),
    accountId: z.string().min(1),
    categoryId: z.string().nullable().optional(),
    counterpartyId: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
  })
  .strict();
export type Template = z.infer<typeof TemplateSchema>;

export const CreateRecurringRuleSchema = z
  .object({
    name: z.string().min(1).max(120),
    template: TemplateSchema,
    frequency: FrequencySchema,
    interval: z.number().int().min(1).max(365).default(1),
    startDate: z.string().min(8),
    endDate: z.string().min(8).nullable().optional(),
    dayOfMonth: z.number().int().min(1).max(31).nullable().optional(),
    dayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
    active: z.boolean().default(true),
  })
  .strict();
export type CreateRecurringRuleDto = z.infer<typeof CreateRecurringRuleSchema>;

export const UpdateRecurringRuleSchema = CreateRecurringRuleSchema.partial();
export type UpdateRecurringRuleDto = z.infer<typeof UpdateRecurringRuleSchema>;
