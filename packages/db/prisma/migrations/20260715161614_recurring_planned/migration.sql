-- CreateEnum
CREATE TYPE "RecurrenceCadence" AS ENUM ('MONTHLY', 'WEEKLY');

-- CreateEnum
CREATE TYPE "PlannedSource" AS ENUM ('RECURRING', 'SALARY', 'MANUAL');

-- CreateEnum
CREATE TYPE "PlannedStatus" AS ENUM ('PLANNED', 'PAID', 'SKIPPED', 'CANCELLED');

-- CreateTable
CREATE TABLE "RecurringPayment" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "txKind" "TransactionKind" NOT NULL DEFAULT 'FIXED_COST',
    "cadence" "RecurrenceCadence" NOT NULL DEFAULT 'MONTHLY',
    "dayOfMonth" INTEGER,
    "weekday" INTEGER,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "leadDays" INTEGER NOT NULL DEFAULT 3,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "accountId" TEXT,
    "categoryId" TEXT,
    "counterpartyId" TEXT,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "RecurringPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlannedPayment" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "txKind" "TransactionKind" NOT NULL DEFAULT 'FIXED_COST',
    "dueDate" TIMESTAMP(3) NOT NULL,
    "source" "PlannedSource" NOT NULL DEFAULT 'MANUAL',
    "status" "PlannedStatus" NOT NULL DEFAULT 'PLANNED',
    "leadDays" INTEGER NOT NULL DEFAULT 3,
    "recurringId" TEXT,
    "accountId" TEXT,
    "categoryId" TEXT,
    "counterpartyId" TEXT,
    "note" TEXT,
    "matchedTransactionId" TEXT,
    "autoTx" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "PlannedPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecurringPayment_workspaceId_isActive_deletedAt_idx" ON "RecurringPayment"("workspaceId", "isActive", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PlannedPayment_matchedTransactionId_key" ON "PlannedPayment"("matchedTransactionId");

-- CreateIndex
CREATE INDEX "PlannedPayment_workspaceId_status_dueDate_idx" ON "PlannedPayment"("workspaceId", "status", "dueDate");

-- CreateIndex
CREATE INDEX "PlannedPayment_recurringId_idx" ON "PlannedPayment"("recurringId");

-- AddForeignKey
ALTER TABLE "RecurringPayment" ADD CONSTRAINT "RecurringPayment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringPayment" ADD CONSTRAINT "RecurringPayment_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringPayment" ADD CONSTRAINT "RecurringPayment_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringPayment" ADD CONSTRAINT "RecurringPayment_counterpartyId_fkey" FOREIGN KEY ("counterpartyId") REFERENCES "Counterparty"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringPayment" ADD CONSTRAINT "RecurringPayment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlannedPayment" ADD CONSTRAINT "PlannedPayment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlannedPayment" ADD CONSTRAINT "PlannedPayment_recurringId_fkey" FOREIGN KEY ("recurringId") REFERENCES "RecurringPayment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlannedPayment" ADD CONSTRAINT "PlannedPayment_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlannedPayment" ADD CONSTRAINT "PlannedPayment_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlannedPayment" ADD CONSTRAINT "PlannedPayment_counterpartyId_fkey" FOREIGN KEY ("counterpartyId") REFERENCES "Counterparty"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlannedPayment" ADD CONSTRAINT "PlannedPayment_matchedTransactionId_fkey" FOREIGN KEY ("matchedTransactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlannedPayment" ADD CONSTRAINT "PlannedPayment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Ф5: идемпотентная материализация регулярки. Одна активная плановая позиция на
-- (правило, дата) — повторный прогон генератора/крона не задваивает. Частичный
-- (WHERE deletedAt IS NULL): мягко удалённые/пересозданные не конфликтуют; NULL
-- recurringId (ручные/зарплата) вне ограничения — их может быть много на дату.
CREATE UNIQUE INDEX "PlannedPayment_recurring_due_key"
  ON "PlannedPayment" ("recurringId", "dueDate")
  WHERE "deletedAt" IS NULL AND "recurringId" IS NOT NULL;
