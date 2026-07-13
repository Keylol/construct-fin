import { z } from 'zod';

const TxTypeEnum = z.enum(['INCOME', 'EXPENSE']);

const moneyString = z
  .string()
  .regex(/^-?\d+(\.\d{1,2})?$/, 'must be a decimal with up to 2 fraction digits');

const isoDate = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), 'invalid ISO date');

const cuid = z.string().min(1).max(64);

// kind, разрешённые для РУЧНОГО ввода через transaction API, сгруппированы по type.
// Системные kind (ORDER_PAYMENT/ORDER_REFUND/COGS/PURCHASE) создаются ТОЛЬКО
// доменными сервисами (заказ/закупка) и сюда НЕ входят — менять их через дженерик
// transaction-endpoint нельзя (см. transaction.service + Фаза 3 п.16).
export const MANUAL_KINDS_BY_TYPE = {
  INCOME: ['CAPITAL_IN', 'OTHER'],
  EXPENSE: ['SALARY', 'TAX', 'FIXED_COST', 'VARIABLE_COST', 'NON_OP', 'CAPITAL_OUT', 'OTHER'],
} as const;

// Объединённый whitelist (любой системный kind отвергается уже на парсинге enum).
const ManualKindEnum = z.enum([
  'CAPITAL_IN',
  'CAPITAL_OUT',
  'SALARY',
  'TAX',
  'FIXED_COST',
  'VARIABLE_COST',
  'NON_OP',
  'OTHER',
]);

/** Проверка соответствия kind ↔ type (kind должен быть допустим для своего type). */
export function isKindAllowedForType(type: 'INCOME' | 'EXPENSE', kind: string): boolean {
  return (MANUAL_KINDS_BY_TYPE[type] as readonly string[]).includes(kind);
}

export const CreateTransactionSchema = z
  .object({
    date: isoDate,
    amount: moneyString,
    type: TxTypeEnum,
    kind: ManualKindEnum.optional(),
    accountId: cuid,
    categoryId: cuid.nullable().optional(),
    counterpartyId: cuid.nullable().optional(),
    description: z.string().trim().max(500).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.kind && !isKindAllowedForType(val.type, val.kind)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['kind'],
        message: `kind ${val.kind} недопустим для type ${val.type}`,
      });
    }
  });
export type CreateTransactionDto = z.infer<typeof CreateTransactionSchema>;

export const UpdateTransactionSchema = z.object({
  date: isoDate.optional(),
  amount: moneyString.optional(),
  type: TxTypeEnum.optional(),
  // Только ручные kind. Соответствие kind↔type против итогового type проверяется
  // в transaction.service (здесь type может отсутствовать в частичном апдейте).
  kind: ManualKindEnum.optional(),
  accountId: cuid.optional(),
  categoryId: cuid.nullable().optional(),
  counterpartyId: cuid.nullable().optional(),
  description: z.string().trim().max(500).nullable().optional(),
});
export type UpdateTransactionDto = z.infer<typeof UpdateTransactionSchema>;

// #13: from/to задают период; from > to — заведомо пустой/ошибочный диапазон,
// отклоняем явно (а не молча возвращаем 0 строк). Общий рефайн для обеих схем.
const assertFromBeforeTo = (
  val: { from?: string; to?: string },
  ctx: z.RefinementCtx,
) => {
  if (val.from && val.to && Date.parse(val.from) > Date.parse(val.to)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['to'],
      message: 'to не может быть раньше from',
    });
  }
};

// P&L-бакеты для drill-down из ОПиУ «По группам». Значения = enum CategoryBucket
// (schema.prisma); фильтр повторяет атрибуцию pnl.service: бакет категории,
// для бескатегорийных — по kind (bucketForSystemKind), переводы исключены.
const BucketEnum = z.enum([
  'REVENUE',
  'COGS',
  'PURCHASES',
  'FIXED',
  'VARIABLE',
  'TAX',
  'CAPITAL',
  'OTHER',
]);

export const ListTransactionsQuerySchema = z
  .object({
    from: isoDate.optional(),
    to: isoDate.optional(),
    accountId: cuid.optional(),
    categoryId: cuid.optional(),
    counterpartyId: cuid.optional(),
    type: TxTypeEnum.optional(),
    bucket: BucketEnum.optional(),
    minAmount: moneyString.optional(),
    maxAmount: moneyString.optional(),
    search: z.string().trim().min(1).optional(),
    cursor: cuid.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .superRefine(assertFromBeforeTo);
export type ListTransactionsQuery = z.infer<typeof ListTransactionsQuerySchema>;

export const TransactionSummaryQuerySchema = z
  .object({
    from: isoDate.optional(),
    to: isoDate.optional(),
  })
  .superRefine(assertFromBeforeTo);
export type TransactionSummaryQuery = z.infer<typeof TransactionSummaryQuerySchema>;
