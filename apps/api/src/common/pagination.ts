import { z } from 'zod';

/**
 * Cursor-based pagination. Курсор — id последнего элемента предыдущей страницы.
 */
export const PaginationQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

export interface PaginatedResult<T> {
  items: T[];
  nextCursor: string | null;
}

export function buildPaginatedResult<T extends { id: string }>(
  items: T[],
  limit: number,
): PaginatedResult<T> {
  if (items.length <= limit) return { items, nextCursor: null };
  const page = items.slice(0, limit);
  const last = page[page.length - 1];
  return { items: page, nextCursor: last?.id ?? null };
}
