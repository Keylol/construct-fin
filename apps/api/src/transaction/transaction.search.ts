import { Prisma } from '@prisma/client';
import type { SearchSpec } from '../common/text-search';

/**
 * Поиск операций. Операцию ищут не только по описанию: по контрагенту, статье,
 * счёту, заказу, к которому она привязана, по контрагенту из строки выписки, по
 * телефону и ИНН — и чаще всего по сумме.
 */
export function transactionSearchSpec(workspaceId: string): SearchSpec {
  return {
    from: Prisma.sql`"Transaction" t
      JOIN "Account" acc ON acc.id = t."accountId"
      LEFT JOIN "Counterparty" cp ON cp.id = t."counterpartyId"
      LEFT JOIN "Category" cat ON cat.id = t."categoryId"
      LEFT JOIN "Order" o ON o.id = t."orderId"
      LEFT JOIN "BankStatementLine" bl ON bl."transactionId" = t.id`,
    id: Prisma.sql`t.id`,
    where: Prisma.sql`t."workspaceId" = ${workspaceId} AND t."deletedAt" IS NULL`,
    fields: [
      { text: Prisma.sql`t.description` },
      { text: Prisma.sql`cp.name` },
      { text: Prisma.sql`cat.name` },
      { text: Prisma.sql`acc.name` },
      { text: Prisma.sql`o.number` },
      { text: Prisma.sql`o.title` },
      { text: Prisma.sql`bl."counterpartyName"` },
      { digits: Prisma.sql`o.phone` },
      { digits: Prisma.sql`cp.contact` },
      { digits: Prisma.sql`cp.inn` },
      { digits: Prisma.sql`bl."counterpartyInn"` },
      { amount: Prisma.sql`t.amount` },
    ],
  };
}
