-- Шаг 1/2 упрощения схемы: РЕМАП данных перед удалением enum-значений.
-- На этот момент старые значения (DRAFT/CARD/NON_OP) ещё существуют в enum,
-- поэтому UPDATE валиден. Дроп самих значений — в следующей миграции.
--
--   OrderStatus.DRAFT      → OPEN   (заказы больше не имеют черновиков)
--   AccountType.CARD       → BANK   (карта учитывается как банковский счёт)
--   CategoryBucket.NON_OP  → OTHER  (внереализационные → прочее; в P&L считается так же)

UPDATE "Order"    SET "status" = 'OPEN'  WHERE "status" = 'DRAFT';
UPDATE "Account"  SET "type"   = 'BANK'  WHERE "type"   = 'CARD';
UPDATE "Category" SET "bucket" = 'OTHER' WHERE "bucket" = 'NON_OP';
