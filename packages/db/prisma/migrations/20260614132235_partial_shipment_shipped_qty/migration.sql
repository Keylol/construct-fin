-- Частичная отгрузка: накопительное отгруженное количество по позиции заказа.
-- Аддитивно, дефолт 0 — существующие строки получают 0 (ничего не отгружено сверх finalize).
ALTER TABLE "OrderItem" ADD COLUMN "shippedQty" DECIMAL(14,3) NOT NULL DEFAULT 0;
