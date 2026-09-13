import { z } from 'zod';
import { searchParam } from '../common/text-search';

export const GlobalSearchQuerySchema = z.object({
  q: searchParam,
  /** Сколько записей показать в каждой группе; всего в группе — `total`. */
  limit: z.coerce.number().int().min(1).max(10).default(5),
});
export type GlobalSearchQuery = z.infer<typeof GlobalSearchQuerySchema>;
