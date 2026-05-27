-- CreateEnum
CREATE TYPE "CategoryBucket" AS ENUM ('REVENUE', 'COGS', 'FIXED', 'VARIABLE', 'NON_OP', 'TAX', 'CAPITAL', 'OTHER');

-- CreateEnum
CREATE TYPE "CounterpartyRole" AS ENUM ('CLIENT', 'SUPPLIER', 'EMPLOYEE', 'OTHER');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('DRAFT', 'OPEN', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OrderPaymentState" AS ENUM ('UNPAID', 'PARTIAL', 'PAID', 'OVERPAID', 'REFUNDED');

-- CreateEnum
CREATE TYPE "TransactionKind" AS ENUM ('ORDER_PAYMENT', 'CAPITAL_IN', 'ORDER_REFUND', 'PURCHASE', 'SALARY', 'TAX', 'FIXED_COST', 'VARIABLE_COST', 'NON_OP', 'CAPITAL_OUT', 'OTHER');

-- CreateEnum
CREATE TYPE "PeriodStatus" AS ENUM ('OPEN', 'CLOSED');

-- DropIndex
DROP INDEX "Counterparty_workspaceId_isArchived_idx";

-- AlterTable
ALTER TABLE "Category" ADD COLUMN     "bucket" "CategoryBucket" NOT NULL DEFAULT 'OTHER';

-- AlterTable
ALTER TABLE "Counterparty" ADD COLUMN     "inn" TEXT,
ADD COLUMN     "payRate" DECIMAL(14,2),
ADD COLUMN     "position" TEXT,
ADD COLUMN     "role" "CounterpartyRole" NOT NULL DEFAULT 'OTHER',
ADD COLUMN     "source" TEXT;

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "kind" "TransactionKind" NOT NULL DEFAULT 'OTHER',
ADD COLUMN     "orderId" TEXT,
ADD COLUMN     "originalTxId" TEXT,
ADD COLUMN     "reversalReason" TEXT;

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'RUB';

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "clientId" TEXT,
    "number" TEXT NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "status" "OrderStatus" NOT NULL DEFAULT 'DRAFT',
    "paymentStatus" "OrderPaymentState" NOT NULL DEFAULT 'UNPAID',
    "subtotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "discountAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "paidAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "expectedDate" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "warehouseItemId" TEXT,
    "name" TEXT NOT NULL,
    "qty" DECIMAL(14,3) NOT NULL,
    "unitPrice" DECIMAL(14,2) NOT NULL,
    "unitCostAtSale" DECIMAL(14,4),
    "returnedQty" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "lineTotal" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WarehouseItem" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sku" TEXT,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'шт',
    "qty" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "avgCost" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "defaultSupplierId" TEXT,
    "note" TEXT,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "WarehouseItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Purchase" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "supplierId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Purchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseLine" (
    "id" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "warehouseItemId" TEXT NOT NULL,
    "qty" DECIMAL(14,3) NOT NULL,
    "unitPrice" DECIMAL(14,4) NOT NULL,
    "lineTotal" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountingPeriod" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "status" "PeriodStatus" NOT NULL DEFAULT 'OPEN',
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountingPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Order_workspaceId_status_expectedDate_idx" ON "Order"("workspaceId", "status", "expectedDate");

-- CreateIndex
CREATE INDEX "Order_workspaceId_clientId_idx" ON "Order"("workspaceId", "clientId");

-- CreateIndex
CREATE INDEX "Order_workspaceId_deletedAt_idx" ON "Order"("workspaceId", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Order_workspaceId_number_key" ON "Order"("workspaceId", "number");

-- CreateIndex
CREATE INDEX "OrderItem_orderId_idx" ON "OrderItem"("orderId");

-- CreateIndex
CREATE INDEX "OrderItem_warehouseItemId_idx" ON "OrderItem"("warehouseItemId");

-- CreateIndex
CREATE INDEX "WarehouseItem_workspaceId_isArchived_idx" ON "WarehouseItem"("workspaceId", "isArchived");

-- CreateIndex
CREATE INDEX "WarehouseItem_workspaceId_deletedAt_idx" ON "WarehouseItem"("workspaceId", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WarehouseItem_workspaceId_sku_key" ON "WarehouseItem"("workspaceId", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "Purchase_transactionId_key" ON "Purchase"("transactionId");

-- CreateIndex
CREATE INDEX "Purchase_workspaceId_createdAt_idx" ON "Purchase"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "Purchase_supplierId_idx" ON "Purchase"("supplierId");

-- CreateIndex
CREATE INDEX "Purchase_workspaceId_deletedAt_idx" ON "Purchase"("workspaceId", "deletedAt");

-- CreateIndex
CREATE INDEX "PurchaseLine_purchaseId_idx" ON "PurchaseLine"("purchaseId");

-- CreateIndex
CREATE INDEX "PurchaseLine_warehouseItemId_idx" ON "PurchaseLine"("warehouseItemId");

-- CreateIndex
CREATE INDEX "AccountingPeriod_workspaceId_status_idx" ON "AccountingPeriod"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AccountingPeriod_workspaceId_year_month_key" ON "AccountingPeriod"("workspaceId", "year", "month");

-- CreateIndex
CREATE INDEX "Category_workspaceId_bucket_idx" ON "Category"("workspaceId", "bucket");

-- CreateIndex
CREATE INDEX "Counterparty_workspaceId_role_isArchived_idx" ON "Counterparty"("workspaceId", "role", "isArchived");

-- CreateIndex
CREATE INDEX "Transaction_workspaceId_kind_date_idx" ON "Transaction"("workspaceId", "kind", "date");

-- CreateIndex
CREATE INDEX "Transaction_workspaceId_orderId_idx" ON "Transaction"("workspaceId", "orderId");

-- CreateIndex
CREATE INDEX "Transaction_originalTxId_idx" ON "Transaction"("originalTxId");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Counterparty"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_warehouseItemId_fkey" FOREIGN KEY ("warehouseItemId") REFERENCES "WarehouseItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WarehouseItem" ADD CONSTRAINT "WarehouseItem_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WarehouseItem" ADD CONSTRAINT "WarehouseItem_defaultSupplierId_fkey" FOREIGN KEY ("defaultSupplierId") REFERENCES "Counterparty"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Counterparty"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseLine" ADD CONSTRAINT "PurchaseLine_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseLine" ADD CONSTRAINT "PurchaseLine_warehouseItemId_fkey" FOREIGN KEY ("warehouseItemId") REFERENCES "WarehouseItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_originalTxId_fkey" FOREIGN KEY ("originalTxId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountingPeriod" ADD CONSTRAINT "AccountingPeriod_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountingPeriod" ADD CONSTRAINT "AccountingPeriod_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
