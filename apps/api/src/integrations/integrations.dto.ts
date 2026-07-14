import { z } from 'zod';

const cuid = z.string().min(1).max(64);

// Провайдеры, доступные для ручного создания подключения. WB_CARD подключается
// через PDF-загрузку (Ф6), не через токен — поэтому здесь только банки.
const ConnectableProvider = z.enum(['ALFA', 'TBANK']);

export const CreateIntegrationSchema = z.object({
  provider: ConnectableProvider,
  accountId: cuid,
  /** Секрет провайдера (токен API). Хранится только в зашифрованном виде. */
  token: z.string().min(1).max(4096),
});
export type CreateIntegrationDto = z.infer<typeof CreateIntegrationSchema>;

export const UpdateIntegrationSchema = z
  .object({
    /** Ротация токена — заменяет секрет без пересоздания подключения. */
    token: z.string().min(1).max(4096).optional(),
    /** Владелец может включить/выключить синк. ERROR ставит только сам синк. */
    status: z.enum(['ACTIVE', 'DISABLED']).optional(),
  })
  .refine((v) => v.token !== undefined || v.status !== undefined, {
    message: 'Нужно передать token и/или status',
  });
export type UpdateIntegrationDto = z.infer<typeof UpdateIntegrationSchema>;
