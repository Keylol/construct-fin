import { z } from 'zod';

const cuid = z.string().min(1).max(64);

export const ListInboxSchema = z.object({
  cursor: cuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  // По умолчанию — строки на разбор. AUTO_POSTED нужен, чтобы ревизовать то, что
  // правила провели сами: до этого авто-проведённое не было видно нигде.
  status: z.enum(['NEW', 'AUTO_POSTED', 'RESOLVED', 'DISMISSED']).default('NEW'),
  /**
   * Поиск по назначению, контрагенту и ИНН. Отдельно разбирается число: строку
   * ищут прежде всего по сумме («вот этот платёж на 66 019»), а сумма хранится
   * Decimal — по ней текстом не найти.
   */
  q: z.string().trim().max(100).optional(),
  /** Только приходы или только расходы. */
  direction: z.enum(['INCOME', 'EXPENSE']).optional(),
  /** Счёт, на который пришла строка (у строки он через подключение). */
  accountId: cuid.optional(),
  /** Диапазон дат — когда разбирают конкретный месяц. */
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});
export type ListInboxQuery = z.infer<typeof ListInboxSchema>;

/**
 * Массовый откат авто-проведённого: либо перечислением строк, либо целиком по
 * правилу («правило оказалось неверным — снять всё, что оно натворило»).
 */
export const UndoBulkSchema = z
  .object({
    lineIds: z.array(cuid).min(1).max(500).optional(),
    appliedRuleId: cuid.optional(),
  })
  .refine(
    (v) => (v.lineIds == null) !== (v.appliedRuleId == null),
    'нужно ровно одно: lineIds или appliedRuleId',
  );
export type UndoBulkDto = z.infer<typeof UndoBulkSchema>;

/** Разбор строки → проводка с выбранной категорией. */
export const CategorizeSchema = z.object({
  categoryId: cuid,
  counterpartyId: cuid.optional(),
  description: z.string().trim().max(500).optional(),
});
export type CategorizeDto = z.infer<typeof CategorizeSchema>;

/**
 * Привязать приход к существующему заказу (оплата заказа).
 *
 * `installment` — кредит или рассрочка: банк перечисляет сумму за вычетом своей
 * комиссии, и без этого блока заказ навсегда оставался бы недоплаченным ровно
 * на неё (4 случая из 21 заказа за июль правились двумя действиями вручную).
 * `amount` — полная сумма (обычно остаток по заказу), `fee` — удержанное
 * банком; на счёт садится разница, равная сумме строки.
 */
export const AttachOrderSchema = z.object({
  orderId: cuid,
  installment: z
    .object({
      amount: z.string().regex(/^\d+(\.\d{1,2})?$/, 'Сумма — число с ≤2 знаками'),
      fee: z.string().regex(/^\d+(\.\d{1,2})?$/, 'Комиссия — неотрицательное число с ≤2 знаками'),
    })
    .optional(),
});
export type AttachOrderDto = z.infer<typeof AttachOrderSchema>;

/**
 * Подтвердить, что две строки — один перевод между своими счетами. Комиссию не
 * принимаем: сервер считает её как разницу фактических сумм, иначе присланное
 * значение могло бы разойтись с выпиской и увести баланс счёта.
 */
export const ConfirmTransferSchema = z.object({
  outLineId: cuid,
  inLineId: cuid,
});
export type ConfirmTransferDto = z.infer<typeof ConfirmTransferSchema>;

/** Одна строка — перевод на счёт, выписку которого банк не отдаёт. */
export const MarkTransferSchema = z.object({ counterAccountId: cuid });
export type MarkTransferDto = z.infer<typeof MarkTransferSchema>;

/** Погасить ожидаемый (плановый) платёж этой строкой выписки. */
export const PayPlannedFromLineSchema = z.object({ plannedPaymentId: cuid });
export type PayPlannedFromLineDto = z.infer<typeof PayPlannedFromLineSchema>;
