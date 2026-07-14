-- CreateEnum
CREATE TYPE "IntegrationProvider" AS ENUM ('ALFA', 'TBANK', 'WB_CARD');

-- CreateEnum
CREATE TYPE "IntegrationStatus" AS ENUM ('ACTIVE', 'ERROR', 'DISABLED');

-- CreateEnum
CREATE TYPE "BankLineStatus" AS ENUM ('NEW', 'AUTO_POSTED', 'RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "AusnMark" AS ENUM ('INCOME', 'EXPENSE', 'NOT_COUNTED');

-- CreateTable
CREATE TABLE "IntegrationConnection" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "accountId" TEXT NOT NULL,
    "credentialEnc" TEXT NOT NULL,
    "keyLast4" TEXT NOT NULL,
    "status" "IntegrationStatus" NOT NULL DEFAULT 'ACTIVE',
    "syncCursor" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "lastSyncError" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "IntegrationConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankStatementLine" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "direction" "TxType" NOT NULL,
    "counterpartyName" TEXT,
    "counterpartyInn" TEXT,
    "description" TEXT,
    "ausnMark" "AusnMark",
    "status" "BankLineStatus" NOT NULL DEFAULT 'NEW',
    "suggestedCategoryId" TEXT,
    "transactionId" TEXT,
    "transferId" TEXT,
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankStatementLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IntegrationConnection_workspaceId_deletedAt_idx" ON "IntegrationConnection"("workspaceId", "deletedAt");

-- CreateIndex
CREATE INDEX "IntegrationConnection_accountId_idx" ON "IntegrationConnection"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "BankStatementLine_transactionId_key" ON "BankStatementLine"("transactionId");

-- CreateIndex
CREATE INDEX "BankStatementLine_workspaceId_status_date_idx" ON "BankStatementLine"("workspaceId", "status", "date");

-- CreateIndex
CREATE INDEX "BankStatementLine_connectionId_status_idx" ON "BankStatementLine"("connectionId", "status");

-- CreateIndex

-- CreateIndex
CREATE INDEX "BankStatementLine_transferId_idx" ON "BankStatementLine"("transferId");

-- CreateIndex
CREATE UNIQUE INDEX "BankStatementLine_connectionId_externalId_key" ON "BankStatementLine"("connectionId", "externalId");

-- AddForeignKey
ALTER TABLE "IntegrationConnection" ADD CONSTRAINT "IntegrationConnection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationConnection" ADD CONSTRAINT "IntegrationConnection_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationConnection" ADD CONSTRAINT "IntegrationConnection_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankStatementLine" ADD CONSTRAINT "BankStatementLine_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankStatementLine" ADD CONSTRAINT "BankStatementLine_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "IntegrationConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankStatementLine" ADD CONSTRAINT "BankStatementLine_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankStatementLine" ADD CONSTRAINT "BankStatementLine_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "Transfer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
