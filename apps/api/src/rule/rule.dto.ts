import { z } from 'zod';

/**
 * Валидированный словарь условий/действий движка правил (Блок 1). Zod — ЕДИНСТВЕННЫЙ
 * барьер между пользовательским JSON и движком: движок доверяет уже провалидированному
 * входу. Словарь ФИКСИРОВАННЫЙ (discriminated union по type) — никакого произвольного
 * кода/DSL, поэтому конфиг не может испортить деньги (Тир-1 безопасности).
 */

const moneyString = z
  .string()
  .regex(/^-?\d+(\.\d{1,2})?$/, 'сумма — десятичная строка с ≤2 знаками');
const cuid = z.string().cuid();

// z.union (а не discriminatedUnion): член AMOUNT_RANGE несёт .refine (хотя бы одна
// граница), из-за чего становится ZodEffects — discriminatedUnion такое не принимает.
export const RuleConditionSchema = z.union([
  z.object({ type: z.literal('DESCRIPTION_CONTAINS'), value: z.string().trim().min(1).max(200) }),
  z.object({ type: z.literal('COUNTERPARTY_EQUALS'), counterpartyId: cuid }),
  z.object({ type: z.literal('ACCOUNT_EQUALS'), accountId: cuid }),
  z.object({ type: z.literal('TYPE_EQUALS'), value: z.enum(['INCOME', 'EXPENSE']) }),
  z
    .object({
      type: z.literal('AMOUNT_RANGE'),
      min: moneyString.nullish(),
      max: moneyString.nullish(),
    })
    // Хотя бы одна граница — иначе условие бессмысленно (матчит любую сумму).
    .refine((c) => c.min != null || c.max != null, 'AMOUNT_RANGE: нужна min или max'),
  z.object({ type: z.literal('SOURCE_EQUALS'), value: z.enum(['IMPORT', 'MANUAL']) }),
]);

export const RuleActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('SET_CATEGORY'), categoryId: cuid }),
  z.object({ type: z.literal('SET_COUNTERPARTY'), counterpartyId: cuid }),
  z.object({ type: z.literal('SET_ACCOUNT'), accountId: cuid }),
]);

export const CreateRuleSchema = z.object({
  name: z.string().trim().min(1).max(120),
  priority: z.number().int().min(0).max(1000).default(0),
  isActive: z.boolean().default(true),
  appliesTo: z.enum(['IMPORT', 'MANUAL', 'BOTH']).default('BOTH'),
  // ≥1 условие — защита от «правила на всё» (движок такое тоже не применяет).
  conditions: z.array(RuleConditionSchema).min(1).max(10),
  // ≥1 действие — иначе правило ничего не подсказывает.
  actions: z.array(RuleActionSchema).min(1).max(5),
});
export type CreateRuleDto = z.infer<typeof CreateRuleSchema>;

export const UpdateRuleSchema = CreateRuleSchema.partial();
export type UpdateRuleDto = z.infer<typeof UpdateRuleSchema>;
