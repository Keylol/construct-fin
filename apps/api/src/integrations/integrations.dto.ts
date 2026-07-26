import { z } from 'zod';

const cuid = z.string().min(1).max(64);

// Провайдеры, доступные для ручного создания подключения. WB_CARD подключается
// через PDF-загрузку (Ф6), не через токен — поэтому здесь только банки.
const ConnectableProvider = z.enum(['ALFA', 'TBANK']);

/**
 * Номер расчётного счёта у банка: 20 цифр (стандарт ЦБ). Обязателен обоим
 * банкам — и Альфа, и Т-Банк принимают его параметром запроса выписки.
 */
const accountNumber = z
  .string()
  .trim()
  .regex(/^\d{20}$/, 'Номер счёта — 20 цифр');

export const CreateIntegrationSchema = z
  .object({
    provider: ConnectableProvider,
    accountId: cuid,
    /** Секрет провайдера (API Key Альфы / токен). Хранится только зашифрованным. */
    token: z.string().min(1).max(4096),
    /** Номер расчётного счёта у провайдера (обязателен для банков). */
    accountNumber: accountNumber.optional(),
  })
  .refine((v) => v.accountNumber !== undefined, {
    path: ['accountNumber'],
    message: 'Укажите номер расчётного счёта',
  });
export type CreateIntegrationDto = z.infer<typeof CreateIntegrationSchema>;

export const UpdateIntegrationSchema = z
  .object({
    /** Ротация токена — заменяет секрет без пересоздания подключения. */
    token: z.string().min(1).max(4096).optional(),
    /** Владелец может включить/выключить синк. ERROR ставит только сам синк. */
    status: z.enum(['ACTIVE', 'DISABLED']).optional(),
    /** Исправление номера счёта (опечатка при подключении). */
    accountNumber: accountNumber.optional(),
  })
  .refine(
    (v) => v.token !== undefined || v.status !== undefined || v.accountNumber !== undefined,
    { message: 'Нужно передать token, status и/или accountNumber' },
  );
export type UpdateIntegrationDto = z.infer<typeof UpdateIntegrationSchema>;
