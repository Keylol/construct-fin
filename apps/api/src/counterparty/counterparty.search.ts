import { Prisma } from '@prisma/client';
import type { SearchSpec } from '../common/text-search';

/**
 * Поиск контрагентов (клиенты, поставщики, сотрудники): имя, контакт, заметка,
 * ИНН, источник, должность; телефон из контакта и ИНН — по цифрам, как их
 * набирают.
 */
export function counterpartySearchSpec(workspaceId: string): SearchSpec {
  return {
    from: Prisma.sql`"Counterparty" c`,
    id: Prisma.sql`c.id`,
    where: Prisma.sql`c."workspaceId" = ${workspaceId} AND c."deletedAt" IS NULL`,
    fields: [
      { text: Prisma.sql`c.name` },
      { text: Prisma.sql`c.contact` },
      { text: Prisma.sql`c.note` },
      { text: Prisma.sql`c.inn` },
      { text: Prisma.sql`c.source` },
      { text: Prisma.sql`c.position` },
      { digits: Prisma.sql`c.contact` },
      { digits: Prisma.sql`c.inn` },
    ],
  };
}
