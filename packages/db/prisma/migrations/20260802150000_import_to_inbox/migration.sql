-- Файловый импорт кладёт выписку во «Входящие», а не сразу в операции.
--
-- До этого загруженный файл создавал проводки напрямую, из-за чего выписка,
-- которую банк не отдаёт по API (карта ВБ), выпадала из общего конвейера: к ней
-- не применялись правила, её не видел детектор переводов, к ней нельзя было
-- привязать заказ. Строка «Входящих» жёстко требует подключение, поэтому
-- заводим провайдер FILE — счёт, выписка которого приходит файлом. Токена и
-- адаптера у такого подключения нет, синк его не трогает.
--
-- Миграция написана вручную (не через `migrate dev`), чтобы не тянуть в неё
-- DROP INDEX для partial-unique индексов — см. «Известные грабли» в CLAUDE.md.

-- 1. Провайдер файловых подключений. Значение здесь же не используется:
--    PostgreSQL не даёт применить его в той же транзакции, что и ADD VALUE.
ALTER TYPE "IntegrationProvider" ADD VALUE 'FILE';

-- 2. У файлового подключения нет ни токена, ни его маски.
ALTER TABLE "IntegrationConnection" ALTER COLUMN "credentialEnc" DROP NOT NULL;
ALTER TABLE "IntegrationConnection" ALTER COLUMN "keyLast4" DROP NOT NULL;

-- 3. Связь строки с пакетом импорта: откат пакета снимает именно его строки.
--    SET NULL, а не CASCADE: пакет — журнал загрузки, его удаление не повод
--    молча терять разобранную строку вместе с проводкой.
ALTER TABLE "BankStatementLine" ADD COLUMN "importBatchId" TEXT;
CREATE INDEX "BankStatementLine_importBatchId_idx" ON "BankStatementLine"("importBatchId");
ALTER TABLE "BankStatementLine"
  ADD CONSTRAINT "BankStatementLine_importBatchId_fkey"
  FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
