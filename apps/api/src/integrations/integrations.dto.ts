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

/**
 * Дата, с которой тянуть выписку. Приходит с фронта строкой (`YYYY-MM-DD` из
 * поля даты либо ISO) — приводим к Date здесь, чтобы сервис работал с датой, а
 * не с текстом. Будущее не имеет смысла: выписки за завтра не существует.
 */
const backfillFrom = z.coerce
  .date()
  .refine((d) => d.getTime() <= Date.now(), 'Дата начала выгрузки не может быть в будущем');

/**
 * Клиентский сертификат mTLS: PEM-файлы целиком. Лимит с запасом на цепочку
 * (сертификат ~2 КБ, ключ ~2 КБ, но банк может выдать связку).
 */
const pem = z.string().min(1).max(32_768);
const tlsFields = {
  /** PEM сертификата (открытая часть). */
  tlsCert: pem.optional(),
  /** PEM закрытого ключа — хранится только зашифрованным. */
  tlsKey: pem.optional(),
  /** Пароль закрытого ключа, если банк выдал его защищённым. */
  tlsPassphrase: z.string().max(512).optional(),
};

/** Сертификат и ключ загружают только парой — половина бесполезна. */
const tlsPairRule = (v: { tlsCert?: string; tlsKey?: string }) =>
  (v.tlsCert === undefined) === (v.tlsKey === undefined);
const tlsPairMessage = {
  path: ['tlsCert'],
  message: 'Сертификат и закрытый ключ загружаются вместе',
};

export const CreateIntegrationSchema = z
  .object({
    provider: ConnectableProvider,
    accountId: cuid,
    /** Секрет провайдера (API Key Альфы / токен). Хранится только зашифрованным. */
    token: z.string().min(1).max(4096),
    /** Номер расчётного счёта у провайдера (обязателен для банков). */
    accountNumber: accountNumber.optional(),
    /** Тянуть выписку с этой даты, а не с момента подключения (перезалив). */
    backfillFrom: backfillFrom.optional(),
    ...tlsFields,
  })
  .refine((v) => v.accountNumber !== undefined, {
    path: ['accountNumber'],
    message: 'Укажите номер расчётного счёта',
  })
  .refine(tlsPairRule, tlsPairMessage);
export type CreateIntegrationDto = z.infer<typeof CreateIntegrationSchema>;

export const UpdateIntegrationSchema = z
  .object({
    /** Ротация токена — заменяет секрет без пересоздания подключения. */
    token: z.string().min(1).max(4096).optional(),
    /** Владелец может включить/выключить синк. ERROR ставит только сам синк. */
    status: z.enum(['ACTIVE', 'DISABLED']).optional(),
    /** Исправление номера счёта (опечатка при подключении). */
    accountNumber: accountNumber.optional(),
    /**
     * Дата начала выгрузки. null снимает её (старт снова с даты подключения),
     * поэтому тип nullable, а не просто optional: «не передали» и «сбросить» —
     * разные намерения.
     */
    backfillFrom: backfillFrom.nullable().optional(),
    ...tlsFields,
  })
  .refine(
    (v) =>
      v.token !== undefined ||
      v.status !== undefined ||
      v.accountNumber !== undefined ||
      v.backfillFrom !== undefined ||
      v.tlsCert !== undefined,
    { message: 'Нужно передать token, status, accountNumber, дату выгрузки и/или сертификат' },
  )
  .refine(tlsPairRule, tlsPairMessage);
export type UpdateIntegrationDto = z.infer<typeof UpdateIntegrationSchema>;
