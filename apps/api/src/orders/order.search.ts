import { Prisma } from '@prisma/client';
import { amountIn, textContains, type SearchSpec } from '../common/text-search';

/**
 * Поиск заказов: номер, название, описание, клиент, телефон (набранный с 8
 * тоже), позиции; суммы — итог, оплачено, остаток и суммы отдельных оплат.
 */
export function orderSearchSpec(workspaceId: string): SearchSpec {
  return {
    from: Prisma.sql`"Order" o LEFT JOIN "Counterparty" c ON c.id = o."clientId"`,
    id: Prisma.sql`o.id`,
    where: Prisma.sql`o."workspaceId" = ${workspaceId} AND o."deletedAt" IS NULL`,
    fields: [
      { text: Prisma.sql`o.number` },
      { text: Prisma.sql`o.title` },
      { text: Prisma.sql`o.description` },
      { text: Prisma.sql`c.name` },
      { digits: Prisma.sql`o.phone` },
      { digits: Prisma.sql`c.contact` },
      { amount: Prisma.sql`o."totalAmount"` },
      { amount: Prisma.sql`o."paidAmount"` },
      { amount: Prisma.sql`(o."totalAmount" - o."paidAmount")` },
      {
        custom: (token) => Prisma.sql`EXISTS (
          SELECT 1 FROM "OrderItem" oi
          WHERE oi."orderId" = o.id AND oi."deletedAt" IS NULL
            AND ${textContains(Prisma.sql`oi.name`, token)})`,
      },
      {
        custom: (token) => {
          const amount = amountIn(Prisma.sql`p.amount`, token);
          return (
            amount &&
            Prisma.sql`EXISTS (
              SELECT 1 FROM "Transaction" p
              WHERE p."orderId" = o.id AND p."deletedAt" IS NULL
                AND p.kind IN ('ORDER_PAYMENT', 'ORDER_REFUND') AND ${amount})`
          );
        },
      },
    ],
  };
}
