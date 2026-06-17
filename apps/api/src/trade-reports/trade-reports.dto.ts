import { z } from 'zod';
import { PeriodPresetSchema } from '../reports/reports.dto';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}(T.*)?$/);

/**
 * Период для отчёта маржи (BR3) — опционален: без параметров считаем по всей
 * истории; с preset либо from+to — фильтр по дате закрытия заказа (closedAt).
 */
export const MarginQuerySchema = z
  .object({
    preset: PeriodPresetSchema.optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
  })
  .strict();
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
