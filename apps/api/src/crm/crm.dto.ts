import { z } from 'zod';

/** Поддомен аккаунта без «.amocrm.ru»: латиница, цифры, дефис. */
const subdomain = z
  .string()
  .trim()
  .toLowerCase()
  .transform((v) => v.replace(/^https?:\/\//, '').replace(/\.amocrm\.(ru|com).*$/, ''))
  .pipe(
    z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{1,62}$/, 'Поддомен — латиница, цифры и дефис, без «.amocrm.ru»'),
  );

/** Долгосрочный токен amo — JWT около 1 000 символов; лимит с запасом. */
const token = z
  .string()
  .trim()
  .min(20, 'Токен слишком короткий')
  .max(8192, 'Токен слишком длинный');

const amoId = z.coerce.number().int().positive();

export const CreateCrmConnectionSchema = z.object({
  subdomain,
  token,
  pipelineId: amoId.optional(),
  triggerStatusId: amoId.optional(),
});
export type CreateCrmConnectionDto = z.infer<typeof CreateCrmConnectionSchema>;

export const UpdateCrmConnectionSchema = z.object({
  /** Ротация токена — заменяет секрет без пересоздания подключения. */
  token: token.optional(),
  status: z.enum(['ACTIVE', 'DISABLED']).optional(),
  /** null снимает выбор воронки/порога: «не передали» и «сбросить» — разные намерения. */
  pipelineId: amoId.nullable().optional(),
  triggerStatusId: amoId.nullable().optional(),
});
export type UpdateCrmConnectionDto = z.infer<typeof UpdateCrmConnectionSchema>;

export const ListCrmDealsSchema = z.object({
  /** waiting — ждут заказа; linked — привязаны; dismissed — не учитываются; all — вся воронка. */
  tab: z.enum(['waiting', 'linked', 'all', 'dismissed']).default('waiting'),
  statusId: amoId.optional(),
  /** Имя сделки, контакт, телефон или бюджет. */
  search: z.string().trim().max(200).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListCrmDealsQuery = z.infer<typeof ListCrmDealsSchema>;

export const LinkCrmDealSchema = z.object({
  orderId: z.string().cuid(),
});
export type LinkCrmDealDto = z.infer<typeof LinkCrmDealSchema>;
