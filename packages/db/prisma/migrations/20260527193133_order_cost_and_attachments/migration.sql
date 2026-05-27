-- AlterTable: OrderItem — ручная закупочная себестоимость
ALTER TABLE "OrderItem" ADD COLUMN "unitCost" DECIMAL(14,4);

-- AlterTable: Attachment — полиморфность (transaction ИЛИ order) + workspaceId
ALTER TABLE "Attachment" ADD COLUMN "orderId" TEXT;
ALTER TABLE "Attachment" ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "Attachment" ALTER COLUMN "transactionId" DROP NOT NULL;

-- Backfill workspaceId из связанной транзакции (для уже существующих вложений)
UPDATE "Attachment" a
SET "workspaceId" = t."workspaceId"
FROM "Transaction" t
WHERE a."transactionId" = t."id" AND a."workspaceId" IS NULL;

-- Подчистить осиротевшие вложения без workspace (если транзакция удалена физически)
DELETE FROM "Attachment" WHERE "workspaceId" IS NULL;

-- Теперь колонку можно сделать обязательной
ALTER TABLE "Attachment" ALTER COLUMN "workspaceId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "Attachment_workspaceId_idx" ON "Attachment"("workspaceId");
CREATE INDEX "Attachment_orderId_idx" ON "Attachment"("orderId");

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
