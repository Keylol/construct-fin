import { z } from 'zod';

/**
 * Payload, который шлёт Telegram Login Widget на наш callback.
 * Источник: https://core.telegram.org/widgets/login
 */
export const TelegramLoginPayloadSchema = z.object({
  id: z.number().int(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  username: z.string().optional(),
  photo_url: z.string().url().optional(),
  auth_date: z.number().int(),
  hash: z.string().length(64), // hex SHA-256
});
export type TelegramLoginPayload = z.infer<typeof TelegramLoginPayloadSchema>;

/**
 * Профиль аутентифицированного пользователя (для /auth/me).
 */
export const UserProfileSchema = z.object({
  id: z.string(),
  telegramId: z.string(), // BigInt сериализуется в string
  username: z.string().nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  photoUrl: z.string().nullable(),
});
export type UserProfile = z.infer<typeof UserProfileSchema>;
