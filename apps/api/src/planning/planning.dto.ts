import { z } from 'zod';

/**
 * Ф5. DTO регулярных и плановых платежей. Всё настраивается в приложении:
 * суммы, график, привязки, статус — редактируемые поля, а не константы кода.
 */

const Money = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, 'Сумма — число с ≤2 знаками')
  .refine((v) => Number(v) > 0, 'Сумма должна быть больше 0');

// Расходные kind'ы, доступные для плановых платежей (регулярка/зарплата/разовые).
// Ядро TransactionKind шире — тут только то, что осмысленно как ожидаемый отток.
const PlannedTxKind = z.enum([
  'FIXED_COST',
  'VARIABLE_COST',
  'SALARY',
  'TAX',
  'NON_OP',
  'OTHER',
]);

const cuid = z.string().cuid();
const isoDate = z.string().datetime();

// ── Регулярный платёж ──

const RecurringBase = z.object({
  title: z.string().trim().min(1, 'Название обязательно').max(200),
  amount: Money,
  txKind: PlannedTxKind.default('FIXED_COST'),
  cadence: z.enum(['MONTHLY', 'WEEKLY']),
  dayOfMonth: z.number().int().min(1).max(31).nullish(),
  weekday: z.number().int().min(0).max(6).nullish(),
  startDate: isoDate,
  endDate: isoDate.nullish(),
  leadDays: z.number().int().min(0).max(60).default(3),
  isActive: z.boolean().default(true),
  accountId: cuid.nullish(),
  categoryId: cuid.nullish(),
  counterpartyId: cuid.nullish(),
  note: z.string().trim().max(500).nullish(),
});

/** Согласованность графика: MONTHLY требует dayOfMonth, WEEKLY — weekday. */
function refineCadence(
  data: { cadence: 'MONTHLY' | 'WEEKLY'; dayOfMonth?: number | null; weekday?: number | null },
  ctx: z.RefinementCtx,
) {
  if (data.cadence === 'MONTHLY' && (data.dayOfMonth == null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dayOfMonth'], message: 'Для месячной регулярки укажите число месяца' });
  }
  if (data.cadence === 'WEEKLY' && (data.weekday == null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['weekday'], message: 'Для недельной регулярки укажите день недели' });
  }
}

export const CreateRecurringSchema = RecurringBase.superRefine(refineCadence);
export type CreateRecurringDto = z.infer<typeof CreateRecurringSchema>;

// Обновление: все поля опциональны, но если меняется cadence — проверяем пару.
export const UpdateRecurringSchema = RecurringBase.partial().superRefine((data, ctx) => {
  if (data.cadence) refineCadence(data as never, ctx);
});
export type UpdateRecurringDto = z.infer<typeof UpdateRecurringSchema>;

// ── Плановый платёж ──

export const CreatePlannedSchema = z
  .object({
    title: z.string().trim().min(1, 'Название обязательно').max(200),
    amount: Money,
    txKind: PlannedTxKind.default('FIXED_COST'),
    dueDate: isoDate,
    source: z.enum(['SALARY', 'MANUAL']).default('MANUAL'),
    leadDays: z.number().int().min(0).max(60).default(3),
    accountId: cuid.nullish(),
    categoryId: cuid.nullish(),
    counterpartyId: cuid.nullish(),
    note: z.string().trim().max(500).nullish(),
  })
  .superRefine((data, ctx) => {
    // Зарплата обязана указывать сотрудника (Counterparty role=EMPLOYEE) и kind=SALARY.
    if (data.source === 'SALARY' && !data.counterpartyId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['counterpartyId'], message: 'Для зарплаты укажите сотрудника' });
    }
  });
export type CreatePlannedDto = z.infer<typeof CreatePlannedSchema>;

export const UpdatePlannedSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  amount: Money.optional(),
  txKind: PlannedTxKind.optional(),
  dueDate: isoDate.optional(),
  leadDays: z.number().int().min(0).max(60).optional(),
  accountId: cuid.nullish(),
  categoryId: cuid.nullish(),
  counterpartyId: cuid.nullish(),
  note: z.string().trim().max(500).nullish(),
});
export type UpdatePlannedDto = z.infer<typeof UpdatePlannedSchema>;

/** Смена статуса плана оператором: пропустить/отменить/вернуть в ожидание. */
export const PlannedStatusSchema = z.object({
  status: z.enum(['PLANNED', 'SKIPPED', 'CANCELLED']),
});
export type PlannedStatusDto = z.infer<typeof PlannedStatusSchema>;

/**
 * Оплатить план: либо создать новую проводку (accountId+amount+date), либо
 * привязать уже существующую операцию (transactionId). Одно из двух.
 */
export const PayPlannedSchema = z
  .object({
    transactionId: cuid.optional(),
    accountId: cuid.optional(),
    amount: Money.optional(),
    date: isoDate.optional(),
    note: z.string().trim().max(300).nullish(),
  })
  .superRefine((data, ctx) => {
    if (!data.transactionId && !data.accountId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['accountId'], message: 'Укажите счёт списания или привяжите операцию' });
    }
  });
export type PayPlannedDto = z.infer<typeof PayPlannedSchema>;

// ── Списки / горизонт ──

export const PlannedListQuerySchema = z.object({
  status: z.enum(['PLANNED', 'PAID', 'SKIPPED', 'CANCELLED']).optional(),
  source: z.enum(['RECURRING', 'SALARY', 'MANUAL']).optional(),
  // Зарплатный раздел фильтрует по статье: SALARY покрывает и разовые выплаты
  // (source=SALARY), и материализованные из зарплатной регулярки (source=RECURRING).
  txKind: PlannedTxKind.optional(),
  counterpartyId: cuid.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});
export type PlannedListQuery = z.infer<typeof PlannedListQuerySchema>;

export const UpcomingQuerySchema = z.object({
  horizonDays: z.coerce.number().int().min(1).max(365).default(30),
});
export type UpcomingQuery = z.infer<typeof UpcomingQuerySchema>;

export const ForecastQuerySchema = z.object({
  days: z.coerce.number().int().min(7).max(180).default(60),
});
export type ForecastQuery = z.infer<typeof ForecastQuerySchema>;
