-- Бэкфилл телефона у заказов, заведённых до решения «телефон = номер заказа».
--
-- У большинства номер уже лежит в комментарии («Заказ №89627989801 от …») —
-- его и достаём регуляркой. Десять заказов июля комментария не имели: их номера
-- взяты из спецификаций на Я.Диске и проставлены явно.
--
-- Нормализация здесь та же, что в коде (packages/shared/src/phone.ts): 11 цифр,
-- ведущая 7. Заказы, где телефон извлечь не удалось, остаются с NULL — на
-- плитке у них показывается служебный ORD-номер, пока владелец не впишет номер.
--
-- Миграция написана вручную (не через `migrate dev`) — см. «Известные грабли».
UPDATE "Order"
SET "phone" = '+7' || RIGHT(REGEXP_REPLACE(SUBSTRING("description" FROM '(?:№|\+7|\+|8)?\s?(\d{10,11})'), '\D', '', 'g'), 10)
WHERE "phone" IS NULL
  AND "description" IS NOT NULL
  AND SUBSTRING("description" FROM '(?:№|\+7|\+|8)?\s?(\d{10,11})') IS NOT NULL;

-- Заказы июля без комментария — номера из спецификаций (docx).
UPDATE "Order" SET "phone" = '+79250626520' WHERE "number" = 'ORD-2026-0001' AND "phone" IS NULL;
UPDATE "Order" SET "phone" = '+79998717220' WHERE "number" = 'ORD-2026-0003' AND "phone" IS NULL;
UPDATE "Order" SET "phone" = '+79114025205' WHERE "number" = 'ORD-2026-0004' AND "phone" IS NULL;
UPDATE "Order" SET "phone" = '+79990211170' WHERE "number" = 'ORD-2026-0006' AND "phone" IS NULL;
UPDATE "Order" SET "phone" = '+79121440834' WHERE "number" = 'ORD-2026-0009' AND "phone" IS NULL;
UPDATE "Order" SET "phone" = '+79099089905' WHERE "number" = 'ORD-2026-0012' AND "phone" IS NULL;
UPDATE "Order" SET "phone" = '+79642666444' WHERE "number" = 'ORD-2026-0013' AND "phone" IS NULL;
UPDATE "Order" SET "phone" = '+79270394463' WHERE "number" = 'ORD-2026-0016' AND "phone" IS NULL;
UPDATE "Order" SET "phone" = '+79320932682' WHERE "number" = 'ORD-2026-0020' AND "phone" IS NULL;
UPDATE "Order" SET "phone" = '+79221266702' WHERE "number" = 'ORD-2026-0024' AND "phone" IS NULL;
