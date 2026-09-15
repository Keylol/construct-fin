import { Prisma } from '@prisma/client';
import type { SearchSpec } from '../common/text-search';

/**
 * Поиск строк выписки: назначение, контрагент, ИНН и сумма — строку ищут прежде
 * всего по сумме («вот этот платёж на 66 019»).
 */
export function inboxSearchSpec(workspaceId: string): SearchSpec {
  return {
    from: Prisma.sql`"BankStatementLine" b`,
    id: Prisma.sql`b.id`,
    where: Prisma.sql`b."workspaceId" = ${workspaceId}`,
    fields: [
      { text: Prisma.sql`b.description` },
      { text: Prisma.sql`b."counterpartyName"` },
      { text: Prisma.sql`b."counterpartyInn"` },
      { digits: Prisma.sql`b."counterpartyInn"` },
      { amount: Prisma.sql`b.amount` },
    ],
  };
}
