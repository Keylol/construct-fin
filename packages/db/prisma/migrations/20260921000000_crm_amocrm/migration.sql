-- amoCRM внутри приложения (волна 1): подключение с зашифрованным долгосрочным
-- токеном и снимок сделок. Сделка → человек → заказ; ничего не создаётся само.

-- CreateEnum
CREATE TYPE "CrmProvider" AS ENUM ('AMOCRM');

-- CreateTable
CREATE TABLE "CrmConnection" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "provider" "CrmProvider" NOT NULL DEFAULT 'AMOCRM',
    "subdomain" TEXT NOT NULL,
    "credentialEnc" TEXT NOT NULL,
    "keyLast4" TEXT NOT NULL,
    "accountName" TEXT,
    "pipelineId" INTEGER,
    "triggerStatusId" INTEGER,
    "triggerStatusSort" INTEGER,
    "pipelines" JSONB,
    "status" "IntegrationStatus" NOT NULL DEFAULT 'ACTIVE',
    "syncCursor" TIMESTAMP(3),
    "lastSyncAt" TIMESTAMP(3),
    "lastSyncError" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "CrmConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmDeal" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "externalId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "price" DECIMAL(14,2) NOT NULL,
    "pipelineId" INTEGER NOT NULL,
    "pipelineName" TEXT NOT NULL,
    "statusId" INTEGER NOT NULL,
    "statusName" TEXT NOT NULL,
    "statusSort" INTEGER NOT NULL,
    "isClosed" BOOLEAN NOT NULL DEFAULT false,
    "isWon" BOOLEAN NOT NULL DEFAULT false,
    "responsibleName" TEXT,
    "contactName" TEXT,
    "phone" TEXT,
    "wishes" TEXT,
    "remoteCreatedAt" TIMESTAMP(3) NOT NULL,
    "remoteUpdatedAt" TIMESTAMP(3) NOT NULL,
    "remoteClosedAt" TIMESTAMP(3),
    "orderId" TEXT,
    "linkedAt" TIMESTAMP(3),
    "dismissedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmDeal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CrmConnection_workspaceId_deletedAt_idx" ON "CrmConnection"("workspaceId", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CrmDeal_connectionId_externalId_key" ON "CrmDeal"("connectionId", "externalId");

-- CreateIndex
CREATE INDEX "CrmDeal_workspaceId_orderId_idx" ON "CrmDeal"("workspaceId", "orderId");

-- CreateIndex
CREATE INDEX "CrmDeal_workspaceId_isClosed_statusSort_idx" ON "CrmDeal"("workspaceId", "isClosed", "statusSort");

-- CreateIndex
CREATE INDEX "CrmDeal_workspaceId_phone_idx" ON "CrmDeal"("workspaceId", "phone");

-- AddForeignKey
ALTER TABLE "CrmConnection" ADD CONSTRAINT "CrmConnection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmConnection" ADD CONSTRAINT "CrmConnection_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmDeal" ADD CONSTRAINT "CrmDeal_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmDeal" ADD CONSTRAINT "CrmDeal_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "CrmConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmDeal" ADD CONSTRAINT "CrmDeal_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
