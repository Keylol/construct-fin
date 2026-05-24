-- CreateEnum
CREATE TYPE "RecurringFrequency" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY');

-- AlterTable: Transaction.recurringOccurrenceDate
ALTER TABLE "Transaction" ADD COLUMN "recurringOccurrenceDate" TIMESTAMP(3);

-- CreateIndex: unique(recurringRuleId, recurringOccurrenceDate) for idempotency
CREATE UNIQUE INDEX "Transaction_recurringRuleId_recurringOccurrenceDate_key"
  ON "Transaction"("recurringRuleId", "recurringOccurrenceDate");

-- AlterTable: RecurringRule — drop cron, add structured fields
ALTER TABLE "RecurringRule" DROP COLUMN "cron";
ALTER TABLE "RecurringRule" ADD COLUMN "frequency" "RecurringFrequency" NOT NULL;
ALTER TABLE "RecurringRule" ADD COLUMN "interval" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "RecurringRule" ADD COLUMN "startDate" TIMESTAMP(3) NOT NULL;
ALTER TABLE "RecurringRule" ADD COLUMN "endDate" TIMESTAMP(3);
ALTER TABLE "RecurringRule" ADD COLUMN "dayOfMonth" INTEGER;
ALTER TABLE "RecurringRule" ADD COLUMN "dayOfWeek" INTEGER;
