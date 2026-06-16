-- F2 (Трек F): partial-unique на естественных ключах справочников
-- (WHERE deletedAt IS NULL) — против дублей, пачкающих отчёты P&L/cashflow и
-- авто-маппинг CategoryRule. Заведены сырым SQL (Prisma не умеет partial-unique
-- в @@unique) → НЕ в schema.prisma; имена с суффиксом _active_key защищены
-- CI-guard'ом (F1). Дубли на проде проверены detection-запросом — их нет, индекс
-- применяется чисто. Все индексы аддитивны.

-- Счёт: уникальное имя в пределах активных счетов пространства.
CREATE UNIQUE INDEX "Account_workspaceId_name_active_key"
  ON "Account" ("workspaceId", "name")
  WHERE "deletedAt" IS NULL;

-- Контрагент: уникальный ИНН в пределах активных (только где inn задан).
CREATE UNIQUE INDEX "Counterparty_workspaceId_inn_active_key"
  ON "Counterparty" ("workspaceId", "inn")
  WHERE "deletedAt" IS NULL AND "inn" IS NOT NULL;

-- Категория: уникальная по (пространство, родитель, имя, вид) среди активных.
-- COALESCE(parentId,'') — иначе две категории верхнего уровня (parentId NULL) с
-- одинаковым именем не конфликтовали бы (NULL != NULL в обычном unique).
CREATE UNIQUE INDEX "Category_workspaceId_parentId_name_kind_active_key"
  ON "Category" ("workspaceId", (COALESCE("parentId", '')), "name", "kind")
  WHERE "deletedAt" IS NULL;
