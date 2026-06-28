import { z } from 'zod';
import { PeriodPresetSchema, isoDate } from '../reports/reports.dto';

/**
 * Период для отчёта маржи (BR3) — опционален: без параметров считаем по всей
 * истории; с preset либо from+to — фильтр по дате закрытия заказа (closedAt).
 * Частично заданный период (ровно одна из from/to без preset) — ошибка ввода:
 * иначе он тихо игнорировался бы и считалась вся история (см. marginPeriod).
 */
export const MarginQuerySchema = z
  .object({
    preset: PeriodPresetSchema.optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
  })
  .strict()
  .refine((q) => q.preset != null || !!q.from === !!q.to, {
    message: 'Период: укажите обе границы (from и to) либо preset',
    path: ['from'],
  });
export type MarginQuery = z.infer<typeof MarginQuerySchema>;

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
