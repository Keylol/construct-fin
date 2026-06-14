import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}(T.*)?$/);

/**
 * Дебиторка: «текущая дата» для расчёта возраста заказов опциональна
 * (в тестах прокидываем детерминированную дату; в проде — new Date()).
 */
export const ReceivablesQuerySchema = z
  .object({
    asOf: isoDate.optional(),
  })
  .strict();
export type ReceivablesQuery = z.infer<typeof ReceivablesQuerySchema>;
