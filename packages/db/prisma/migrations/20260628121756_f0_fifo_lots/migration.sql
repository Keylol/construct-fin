-- CreateEnum
CREATE TYPE "StockLotSource" AS ENUM ('PURCHASE', 'OPENING', 'MIGRATION', 'ADJUSTMENT', 'RETURN_CUSTOMER');

-- CreateEnum
CREATE TYPE "LotConsumptionKind" AS ENUM ('CONSUME', 'REVERSAL');

-- CreateTable
CREATE TABLE "StockLot" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "warehouseItemId" TEXT NOT NULL,
    "qtyInitial" DECIMAL(14,3) NOT NULL,
    "qtyRemaining" DECIMAL(14,3) NOT NULL,
    "unitCost" DECIMAL(14,4) NOT NULL,
    "sourceType" "StockLotSource" NOT NULL,
    "sourceId" TEXT,
    "purchaseLineId" TEXT,
    "supplierId" TEXT,
    "accountId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "StockLot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LotConsumption" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "movementId" TEXT NOT NULL,
    "orderItemId" TEXT,
    "qty" DECIMAL(14,3) NOT NULL,
    "unitCost" DECIMAL(14,4) NOT NULL,
    "kind" "LotConsumptionKind" NOT NULL DEFAULT 'CONSUME',
    "reversalOfId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LotConsumption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StockLot_workspaceId_warehouseItemId_receivedAt_seq_idx" ON "StockLot"("workspaceId", "warehouseItemId", "receivedAt", "seq");

-- CreateIndex
CREATE INDEX "StockLot_purchaseLineId_idx" ON "StockLot"("purchaseLineId");

-- CreateIndex
CREATE INDEX "StockLot_workspaceId_supplierId_idx" ON "StockLot"("workspaceId", "supplierId");

-- CreateIndex
CREATE INDEX "LotConsumption_lotId_idx" ON "LotConsumption"("lotId");

-- CreateIndex
CREATE INDEX "LotConsumption_orderItemId_idx" ON "LotConsumption"("orderItemId");

-- CreateIndex
CREATE INDEX "LotConsumption_movementId_idx" ON "LotConsumption"("movementId");

-- CreateIndex
CREATE INDEX "LotConsumption_reversalOfId_idx" ON "LotConsumption"("reversalOfId");

-- AddForeignKey
ALTER TABLE "StockLot" ADD CONSTRAINT "StockLot_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLot" ADD CONSTRAINT "StockLot_warehouseItemId_fkey" FOREIGN KEY ("warehouseItemId") REFERENCES "WarehouseItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLot" ADD CONSTRAINT "StockLot_purchaseLineId_fkey" FOREIGN KEY ("purchaseLineId") REFERENCES "PurchaseLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLot" ADD CONSTRAINT "StockLot_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Counterparty"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLot" ADD CONSTRAINT "StockLot_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLot" ADD CONSTRAINT "StockLot_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LotConsumption" ADD CONSTRAINT "LotConsumption_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LotConsumption" ADD CONSTRAINT "LotConsumption_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "StockLot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LotConsumption" ADD CONSTRAINT "LotConsumption_movementId_fkey" FOREIGN KEY ("movementId") REFERENCES "StockMovement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LotConsumption" ADD CONSTRAINT "LotConsumption_reversalOfId_fkey" FOREIGN KEY ("reversalOfId") REFERENCES "LotConsumption"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── F0 (FIFO): сырой SQL — инварианты партий + partial FIFO-индекс ───
-- Аналогично db_check_constraints/ref_partial_unique: CHECK защищают лот-инварианты
-- от прямого SQL/бага в UoW; partial-индекс ускоряет FIFO-скан открытых лотов.

-- StockLot: партия положительна, остаток в [0, qtyInitial], себестоимость неотрицательна.
ALTER TABLE "StockLot" ADD CONSTRAINT "StockLot_qtyInitial_positive" CHECK ("qtyInitial" > 0);
ALTER TABLE "StockLot" ADD CONSTRAINT "StockLot_qtyRemaining_nonneg" CHECK ("qtyRemaining" >= 0);
ALTER TABLE "StockLot" ADD CONSTRAINT "StockLot_qtyRemaining_lte_initial" CHECK ("qtyRemaining" <= "qtyInitial");
ALTER TABLE "StockLot" ADD CONSTRAINT "StockLot_unitCost_nonneg" CHECK ("unitCost" >= 0);

-- LotConsumption: себестоимость-снимок неотрицательна, qty ненулевая (знаковая: + CONSUME / − REVERSAL).
ALTER TABLE "LotConsumption" ADD CONSTRAINT "LotConsumption_unitCost_nonneg" CHECK ("unitCost" >= 0);
ALTER TABLE "LotConsumption" ADD CONSTRAINT "LotConsumption_qty_nonzero" CHECK ("qty" <> 0);

-- Partial-индекс под FIFO-скан/лок открытых лотов (WHERE qtyRemaining>0 AND deletedAt IS NULL).
-- НЕ в schema.prisma (Prisma не умеет partial-индекс) → known-drift, суффикс _open_fifo_idx.
CREATE INDEX "StockLot_open_fifo_idx"
  ON "StockLot" ("workspaceId", "warehouseItemId", "receivedAt", "seq")
  WHERE "qtyRemaining" > 0 AND "deletedAt" IS NULL;
