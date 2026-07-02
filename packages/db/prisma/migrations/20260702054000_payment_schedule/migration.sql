-- F2 (#8a): график платежей заказа — план «суммы + даты», покрытие строк
-- выводится FIFO из Order.paidAmount (платежи к строкам не привязываются).

-- CreateTable
CREATE TABLE "PaymentScheduleEntry" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "PaymentScheduleEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (seq уникален в заказе — инвариант FIFO-порядка)
CREATE UNIQUE INDEX "PaymentScheduleEntry_orderId_seq_key" ON "PaymentScheduleEntry"("orderId", "seq");

-- CreateIndex
CREATE INDEX "PaymentScheduleEntry_workspaceId_orderId_idx" ON "PaymentScheduleEntry"("workspaceId", "orderId");

-- CreateIndex
CREATE INDEX "PaymentScheduleEntry_workspaceId_dueDate_idx" ON "PaymentScheduleEntry"("workspaceId", "dueDate");

-- AddForeignKey
ALTER TABLE "PaymentScheduleEntry" ADD CONSTRAINT "PaymentScheduleEntry_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentScheduleEntry" ADD CONSTRAINT "PaymentScheduleEntry_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
