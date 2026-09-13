import { Prisma } from '@prisma/client';
import { amountIn, textContains, type SearchSpec } from '../common/text-search';

/**
 * Поиск закупок: поставщик, комментарий, позиции (название и артикул товара),
 * сумма закупки и суммы строк.
 */
export function purchaseSearchSpec(workspaceId: string): SearchSpec {
  return {
    from: Prisma.sql`"Purchase" p
      JOIN "Transaction" t ON t.id = p."transactionId"
      LEFT JOIN "Counterparty" s ON s.id = p."supplierId"`,
    id: Prisma.sql`p.id`,
    where: Prisma.sql`p."workspaceId" = ${workspaceId} AND p."deletedAt" IS NULL`,
    fields: [
      { text: Prisma.sql`s.name` },
      { text: Prisma.sql`p.note` },
      { amount: Prisma.sql`t.amount` },
      {
        custom: (token) => Prisma.sql`EXISTS (
          SELECT 1 FROM "PurchaseLine" pl
          JOIN "WarehouseItem" wi ON wi.id = pl."warehouseItemId"
          WHERE pl."purchaseId" = p.id
            AND (${textContains(Prisma.sql`wi.name`, token)}
              OR ${textContains(Prisma.sql`wi.sku`, token)}))`,
      },
      {
        custom: (token) => {
          const amount = amountIn(Prisma.sql`pl."lineTotal"`, token);
          return (
            amount &&
            Prisma.sql`EXISTS (
              SELECT 1 FROM "PurchaseLine" pl
              WHERE pl."purchaseId" = p.id AND ${amount})`
          );
        },
      },
    ],
  };
}
