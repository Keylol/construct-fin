-- CreateEnum
CREATE TYPE "WbLineTarget" AS ENUM ('WAREHOUSE', 'ORDER', 'SKIPPED');

-- CreateTable
CREATE TABLE "WbReceipt" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "transactionId" TEXT,
    "transactionCreated" BOOLEAN NOT NULL DEFAULT false,
    "fpd" TEXT NOT NULL,
    "fd" TEXT,
    "checkNumber" TEXT,
    "receiptDate" TIMESTAMP(3) NOT NULL,
    "totalAmount" DECIMAL(14,2) NOT NULL,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "WbReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WbReceiptLine" (
    "id" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "qty" DECIMAL(14,3) NOT NULL,
    "unitPrice" DECIMAL(14,4) NOT NULL,
    "lineTotal" DECIMAL(14,2) NOT NULL,
    "sellerName" TEXT,
    "sellerInn" TEXT,
    "wbOrderHash" TEXT,
    "target" "WbLineTarget" NOT NULL,
    "warehouseItemId" TEXT,
    "orderId" TEXT,
    "orderItemId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WbReceiptLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WbReceipt_transactionId_key" ON "WbReceipt"("transactionId");

-- CreateIndex
CREATE INDEX "WbReceipt_workspaceId_receiptDate_idx" ON "WbReceipt"("workspaceId", "receiptDate");

-- CreateIndex
CREATE INDEX "WbReceipt_workspaceId_deletedAt_idx" ON "WbReceipt"("workspaceId", "deletedAt");

-- CreateIndex
CREATE INDEX "WbReceipt_accountId_idx" ON "WbReceipt"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "WbReceiptLine_orderItemId_key" ON "WbReceiptLine"("orderItemId");

-- CreateIndex
CREATE INDEX "WbReceiptLine_receiptId_idx" ON "WbReceiptLine"("receiptId");

-- CreateIndex
CREATE INDEX "WbReceiptLine_orderId_idx" ON "WbReceiptLine"("orderId");

-- CreateIndex
CREATE INDEX "WbReceiptLine_warehouseItemId_idx" ON "WbReceiptLine"("warehouseItemId");

-- AddForeignKey
ALTER TABLE "WbReceipt" ADD CONSTRAINT "WbReceipt_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WbReceipt" ADD CONSTRAINT "WbReceipt_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WbReceipt" ADD CONSTRAINT "WbReceipt_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WbReceipt" ADD CONSTRAINT "WbReceipt_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WbReceiptLine" ADD CONSTRAINT "WbReceiptLine_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "WbReceipt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WbReceiptLine" ADD CONSTRAINT "WbReceiptLine_warehouseItemId_fkey" FOREIGN KEY ("warehouseItemId") REFERENCES "WarehouseItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WbReceiptLine" ADD CONSTRAINT "WbReceiptLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WbReceiptLine" ADD CONSTRAINT "WbReceiptLine_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Идемпотентность повторной загрузки чека: один ФПД — один живой разбор в
-- workspace. Partial-unique (WHERE deletedAt IS NULL) — Prisma не умеет такие
-- @@unique, индекс сырым SQL (соглашение *_active_key; в schema.prisma его НЕТ
-- → известный drift, при новых миграциях не давать prisma его дропнуть).
CREATE UNIQUE INDEX "WbReceipt_workspaceId_fpd_active_key" ON "WbReceipt"("workspaceId", "fpd") WHERE "deletedAt" IS NULL;
