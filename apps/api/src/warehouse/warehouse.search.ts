import { Prisma } from '@prisma/client';
import type { SearchSpec } from '../common/text-search';

/** Поиск складских позиций: название, артикул, цвет, заметка. */
export function warehouseSearchSpec(workspaceId: string): SearchSpec {
  return {
    from: Prisma.sql`"WarehouseItem" w`,
    id: Prisma.sql`w.id`,
    where: Prisma.sql`w."workspaceId" = ${workspaceId} AND w."deletedAt" IS NULL`,
    fields: [
      { text: Prisma.sql`w.name` },
      { text: Prisma.sql`w.sku` },
      { text: Prisma.sql`w.color` },
      { text: Prisma.sql`w.note` },
    ],
  };
}
