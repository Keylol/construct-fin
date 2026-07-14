import { z } from 'zod';

// Паттерн Money/Qty — как в purchase.dto: строго > 0, деньги строками.
const Money = z
  .string()
  .regex(/^\d+(\.\d{1,4})?$/, 'Цена — число с ≤4 знаками')
  .refine((v) => Number(v) > 0, 'Цена должна быть больше 0');
const Qty = z
  .string()
  .regex(/^\d+(\.\d{1,3})?$/, 'Кол-во — число с ≤3 знаками')
  .refine((v) => Number(v) > 0, 'Кол-во должно быть больше 0');

export const WbPreviewQuerySchema = z.object({
  accountId: z.string().cuid(),
});
export type WbPreviewQuery = z.infer<typeof WbPreviewQuerySchema>;

/** Назначение строки чека, размеченное оператором. */
const LineBase = {
  name: z.string().trim().min(1).max(500),
  qty: Qty,
  unitPrice: Money,
  sellerName: z.string().trim().max(300).nullish(),
  sellerInn: z.string().trim().max(20).nullish(),
  wbOrderHash: z.string().trim().max(64).nullish(),
};

const WarehouseLine = z.object({
  ...LineBase,
  target: z.literal('WAREHOUSE'),
  /** Существующий товар склада ЛИБО новый (создаётся на лету). */
  warehouseItemId: z.string().cuid().optional(),
  newItem: z
    .object({
      name: z.string().trim().min(1).max(300),
      unit: z.string().trim().min(1).max(20).default('шт'),
    })
    .optional(),
});

const OrderLine = z.object({
  ...LineBase,
  target: z.literal('ORDER'),
  orderId: z.string().cuid(),
  /** Продажная цена позиции; по умолчанию = цене чека (наценку правят потом). */
  salePrice: Money.optional(),
});

const SkippedLine = z.object({
  ...LineBase,
  target: z.literal('SKIPPED'),
});

export const WbReceiptLineInputSchema = z
  .discriminatedUnion('target', [WarehouseLine, OrderLine, SkippedLine])
  .superRefine((line, ctx) => {
    if (line.target === 'WAREHOUSE') {
      const hasExisting = !!line.warehouseItemId;
      const hasNew = !!line.newItem;
      if (hasExisting === hasNew) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Складская строка: укажите товар ЛИБО новый товар (ровно одно)',
        });
      }
    }
  });
export type WbReceiptLineInput = z.infer<typeof WbReceiptLineInputSchema>;

/** Деньги чека: привязать существующую операцию карты ИЛИ создать расход. */
const MoneyMode = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('link'), transactionId: z.string().cuid() }),
  z.object({ mode: z.literal('create'), categoryId: z.string().cuid().nullish() }),
]);

export const CommitWbReceiptSchema = z.object({
  accountId: z.string().cuid(),
  money: MoneyMode,
  fpd: z.string().trim().min(1).max(40),
  fd: z.string().trim().max(40).nullish(),
  checkNumber: z.string().trim().max(40).nullish(),
  receiptDate: z.string().datetime(),
  /** «Итого» чека; сервер сверяет с Σ строк (включая SKIPPED). */
  totalAmount: Money,
  note: z.string().trim().max(500).nullish(),
  lines: z.array(WbReceiptLineInputSchema).min(1, 'Разметьте хотя бы одну строку'),
});
export type CommitWbReceiptDto = z.infer<typeof CommitWbReceiptSchema>;
