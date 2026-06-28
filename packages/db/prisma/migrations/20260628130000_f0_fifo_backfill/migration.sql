-- F0 (FIFO): backfill партий из текущих WAVG-остатков.
-- На каждую позицию с qty>0, у которой ещё НЕТ партий, создаём ОДИН MIGRATION-лот
-- (qtyInitial=qtyRemaining=qty, unitCost=avgCost, supplier/account/purchaseLine=null,
-- receivedAt=WarehouseItem.createdAt, createdById=владелец workspace). Идемпотентно
-- (NOT EXISTS) — повторный прогон ничего не дублирует. Включает archived/soft-deleted
-- позиции (чтобы инвариант qty==Σ qtyRemaining держался для ВСЕХ). Выполняется до
-- старта нового кода (single-instance деплой), объём мал — чанки не нужны.

INSERT INTO "StockLot" (
  "id", "workspaceId", "warehouseItemId", "qtyInitial", "qtyRemaining", "unitCost",
  "sourceType", "sourceId", "purchaseLineId", "supplierId", "accountId",
  "receivedAt", "createdById", "createdAt"
)
SELECT
  gen_random_uuid()::text,
  w."workspaceId",
  w."id",
  w."qty",
  w."qty",
  w."avgCost",
  'MIGRATION'::"StockLotSource",
  NULL, NULL, NULL, NULL,
  w."createdAt",
  ws."ownerId",
  now()
FROM "WarehouseItem" w
JOIN "Workspace" ws ON ws."id" = w."workspaceId"
WHERE w."qty" > 0
  AND NOT EXISTS (SELECT 1 FROM "StockLot" l WHERE l."warehouseItemId" = w."id");

-- Gate сверки остатков: для КАЖДОЙ позиции с qty>0 кэш qty обязан совпасть с суммой
-- открытых партий. Любое расхождение валит миграцию → авто-откат деплоя (E2).
DO $$
DECLARE bad integer;
BEGIN
  SELECT count(*) INTO bad FROM (
    SELECT w."id"
    FROM "WarehouseItem" w
    LEFT JOIN "StockLot" l
      ON l."warehouseItemId" = w."id" AND l."qtyRemaining" > 0 AND l."deletedAt" IS NULL
    WHERE w."qty" > 0
    GROUP BY w."id", w."qty"
    HAVING w."qty" <> COALESCE(SUM(l."qtyRemaining"), 0)
  ) t;
  IF bad > 0 THEN
    RAISE EXCEPTION 'F0 backfill: сверка остатков не сошлась у % позиций (qty != Σ lot.qtyRemaining)', bad;
  END IF;
END $$;
