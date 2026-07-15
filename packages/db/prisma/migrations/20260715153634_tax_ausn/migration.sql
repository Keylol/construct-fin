-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "ausnMark" "AusnMark",
ADD COLUMN     "taxPeriod" TEXT;

-- CreateIndex
CREATE INDEX "Transaction_workspaceId_taxPeriod_idx" ON "Transaction"("workspaceId", "taxPeriod");
