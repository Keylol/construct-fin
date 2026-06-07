-- AlterTable
ALTER TABLE "IdempotencyKey" ADD COLUMN     "completedAt" TIMESTAMP(3);

-- Бэкафилл: до этой миграции запись в IdempotencyKey появлялась ТОЛЬКО при
-- завершении запроса (старая логика писала ответ в tap после выполнения),
-- поэтому все существующие строки — завершённые. Проставляем completedAt, иначе
-- новая логика сочла бы их «в обработке» и отдавала бы ложный 409 до истечения TTL.
UPDATE "IdempotencyKey" SET "completedAt" = "createdAt" WHERE "completedAt" IS NULL;
