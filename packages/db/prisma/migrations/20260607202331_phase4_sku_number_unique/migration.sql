-- Фаза 4 п.21: уникальность Order.number и WarehouseItem.sku — с учётом soft-delete.
--
-- Было: глобальный @@unique([workspaceId, number]) и @@unique([workspaceId, sku]).
-- Проблема: soft-deleted строка продолжала «занимать» номер/sku, поэтому после
-- удаления заказа/позиции нельзя было создать новую с тем же номером/артикулом.
--
-- Стало: partial-unique только среди АКТИВНЫХ строк (deletedAt IS NULL). Prisma
-- не умеет partial-@@unique в схеме, поэтому индекс заводится сырым SQL и не
-- отражён в schema.prisma (будущий `prisma migrate dev` увидит drift — см.
-- CLAUDE.md → «Известные грабли»).
--
-- Дроп старых индексов безопасен: меняется индекс, не данные; на момент миграции
-- обе таблицы пусты (проверено на проде: 0 строк). Partial — строго слабее
-- старого глобального, новых конфликтов на существующих данных не создаёт.

-- Order.number
DROP INDEX "Order_workspaceId_number_key";
CREATE UNIQUE INDEX "Order_workspaceId_number_active_key"
  ON "Order" ("workspaceId", "number")
  WHERE "deletedAt" IS NULL;

-- WarehouseItem.sku (sku опционален → NULL'ы из индекса исключаем явно;
-- несколько активных позиций без sku сосуществуют, как и раньше)
DROP INDEX "WarehouseItem_workspaceId_sku_key";
CREATE UNIQUE INDEX "WarehouseItem_workspaceId_sku_active_key"
  ON "WarehouseItem" ("workspaceId", "sku")
  WHERE "deletedAt" IS NULL AND "sku" IS NOT NULL;
