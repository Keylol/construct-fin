-- Конфигурируемость Блок 1 (Фаза C, «полное объединение»): переносим существующие
-- CategoryRule в движок Rule, чтобы после перевода импорта на движок исторические
-- правила категоризации продолжали работать без ручной пересборки пользователем.
--
-- Маппинг 1:1, сохраняющий прежнее поведение matcher.ts при импорте:
--   keyword         → условие DESCRIPTION_CONTAINS(keyword)
--   category.kind   → условие TYPE_EQUALS(kind)   (matcher неявно фильтровал по kind
--                     категории: расходное правило не липло к доходной строке)
--   categoryId      → действие SET_CATEGORY(categoryId)
--   priority        → priority (как есть)
--   isActive        → isActive (как есть)
--   appliesTo = 'IMPORT' — CategoryRule влиял ТОЛЬКО на импорт, не на ручной ввод.
--
-- Только data-миграция (INSERT), без изменения схемы. CategoryRule/таблица остаются
-- как deprecated (не роняем данные, обратимо). Правила на удалённую категорию не
-- переносим (INNER JOIN по Category.deletedAt IS NULL) — они и раньше были битыми.
--
-- id новых строк генерим gen_random_uuid()::text (в PG13+ функция в ядре). Формат
-- не cuid, но потребителям это неважно: движок сортирует по id.localeCompare, а cuid
-- в rule.dto.ts проверяется только для ВХОДА API, не для хранимых значений.

INSERT INTO "Rule" (
  "id", "workspaceId", "name", "priority", "isActive", "appliesTo",
  "conditions", "actions", "createdAt", "updatedAt", "deletedAt"
)
SELECT
  gen_random_uuid()::text,
  cr."workspaceId",
  cr."keyword",
  cr."priority",
  cr."isActive",
  'IMPORT',
  jsonb_build_array(
    jsonb_build_object('type', 'DESCRIPTION_CONTAINS', 'value', cr."keyword"),
    jsonb_build_object('type', 'TYPE_EQUALS', 'value', cat."kind"::text)
  ),
  jsonb_build_array(
    jsonb_build_object('type', 'SET_CATEGORY', 'categoryId', cr."categoryId")
  ),
  cr."createdAt",
  cr."updatedAt",
  NULL
FROM "CategoryRule" cr
JOIN "Category" cat
  ON cat."id" = cr."categoryId"
 AND cat."deletedAt" IS NULL
WHERE cr."deletedAt" IS NULL
  AND btrim(cr."keyword") <> '';
