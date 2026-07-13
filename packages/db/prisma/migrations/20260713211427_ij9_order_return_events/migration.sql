-- CreateTable
CREATE TABLE "OrderReturn" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "qty" DECIMAL(14,3) NOT NULL,
    "revenueAmount" DECIMAL(14,2) NOT NULL,
    "costAmount" DECIMAL(14,2) NOT NULL,
    "refundAmount" DECIMAL(14,2) NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT NOT NULL,

    CONSTRAINT "OrderReturn_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderReturn_workspaceId_date_idx" ON "OrderReturn"("workspaceId", "date");

-- CreateIndex
CREATE INDEX "OrderReturn_orderId_idx" ON "OrderReturn"("orderId");

-- CreateIndex
CREATE INDEX "OrderReturn_orderItemId_idx" ON "OrderReturn"("orderItemId");

-- AddForeignKey
ALTER TABLE "OrderReturn" ADD CONSTRAINT "OrderReturn_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderReturn" ADD CONSTRAINT "OrderReturn_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderReturn" ADD CONSTRAINT "OrderReturn_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderReturn" ADD CONSTRAINT "OrderReturn_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────── Backfill истории (IJ9) ───────────────────────────
-- OrderItem.returnedQty — накопительный кэш без даты. Сеем события возврата:
-- даты best-effort, все строки помечены note LIKE 'BACKFILL%'.
-- Инвариант после backfill: Σ qty событий ЗАКАЗА == Σ returnedQty его позиций
-- (при неоднозначном матчинге одинаковых SKU внутри заказа возможен перекос
-- между позициями, но не по заказу в целом).

-- 1) Склад: из StockMovement RETURN_CUSTOMER (дата события известна).
--    Матчинг позиции: refId = orderId + warehouseItemId, первая по createdAt.
INSERT INTO "OrderReturn"
  ("id", "workspaceId", "orderId", "orderItemId", "qty", "revenueAmount", "costAmount",
   "refundAmount", "date", "note", "createdById")
SELECT
  gen_random_uuid()::text,
  m."workspaceId",
  oi."orderId",
  oi."id",
  m."qtyDelta",
  ROUND(m."qtyDelta" * oi."unitPrice", 2),
  ROUND(m."qtyDelta" * COALESCE(oi."unitCostAtSale", oi."unitCost", 0), 2),
  0,
  m."createdAt",
  'BACKFILL:stock-movement ' || m."id",
  m."createdById"
FROM "StockMovement" m
JOIN LATERAL (
  SELECT i."id", i."orderId", i."unitPrice", i."unitCostAtSale", i."unitCost"
  FROM "OrderItem" i
  WHERE i."orderId" = m."refId"
    AND i."warehouseItemId" = m."warehouseItemId"
    AND i."deletedAt" IS NULL
  ORDER BY i."createdAt"
  LIMIT 1
) oi ON TRUE
WHERE m."type" = 'RETURN_CUSTOMER'
  AND m."refType" = 'Order'
  AND m."qtyDelta" > 0;

-- 2) Остаток returnedQty, не покрытый движениями (ручные позиции и т.п.) —
--    одно событие датой закрытия заказа (лучшее доступное приближение).
INSERT INTO "OrderReturn"
  ("id", "workspaceId", "orderId", "orderItemId", "qty", "revenueAmount", "costAmount",
   "refundAmount", "date", "note", "createdById")
SELECT
  gen_random_uuid()::text,
  o."workspaceId",
  oi."orderId",
  oi."id",
  oi."returnedQty" - COALESCE(r."covered", 0),
  ROUND((oi."returnedQty" - COALESCE(r."covered", 0)) * oi."unitPrice", 2),
  ROUND((oi."returnedQty" - COALESCE(r."covered", 0)) * COALESCE(oi."unitCostAtSale", oi."unitCost", 0), 2),
  0,
  COALESCE(o."closedAt", o."updatedAt"),
  'BACKFILL:residual',
  w."ownerId"
FROM "OrderItem" oi
JOIN "Order" o ON o."id" = oi."orderId"
JOIN "Workspace" w ON w."id" = o."workspaceId"
LEFT JOIN (
  SELECT "orderItemId", SUM("qty") AS "covered"
  FROM "OrderReturn"
  GROUP BY "orderItemId"
) r ON r."orderItemId" = oi."id"
WHERE oi."returnedQty" > COALESCE(r."covered", 0)
  AND oi."deletedAt" IS NULL;
