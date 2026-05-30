-- Пачка 3 упрощения: дроп неиспользуемых таблиц Recurring и Period close.
-- Бизнес-данных в них нет (модули удалены в пачке 1). Soft-delete не применяем —
-- таблицы уходят физически вместе со связями и enum'ами.

-- DropForeignKey
ALTER TABLE "AccountingPeriod" DROP CONSTRAINT "AccountingPeriod_closedById_fkey";

-- DropForeignKey
ALTER TABLE "AccountingPeriod" DROP CONSTRAINT "AccountingPeriod_workspaceId_fkey";

-- DropForeignKey
ALTER TABLE "RecurringRule" DROP CONSTRAINT "RecurringRule_workspaceId_fkey";

-- DropForeignKey
ALTER TABLE "Transaction" DROP CONSTRAINT "Transaction_recurringRuleId_fkey";

-- DropIndex
DROP INDEX "Transaction_recurringRuleId_recurringOccurrenceDate_key";

-- AlterTable
ALTER TABLE "Transaction" DROP COLUMN "recurringOccurrenceDate",
DROP COLUMN "recurringRuleId";

-- DropTable
DROP TABLE "AccountingPeriod";

-- DropTable
DROP TABLE "RecurringRule";

-- DropEnum
DROP TYPE "PeriodStatus";

-- DropEnum
DROP TYPE "RecurringFrequency";
