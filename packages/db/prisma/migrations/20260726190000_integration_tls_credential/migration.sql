-- Ф2 (мультитенантность): клиентский сертификат mTLS переезжает из env сервера
-- в само подключение. Банк выдаёт сертификат на компанию по договору, поэтому
-- у двух пространств (разные ИП) сертификаты разные, и один общий на процесс
-- не годится.
--
-- tlsCredentialEnc — зашифрованный JSON {cert, key, passphrase} (AES-256-GCM,
-- тот же мастер-ключ, что и у credentialEnc). Метаданные сертификата
-- (отпечаток и срок) хранятся открыто: это публичная часть, нужная UI.
--
-- Все поля nullable: у Т-Банка сертификата нет вовсе, а существующие
-- подключения Альфы продолжают работать на сертификате из env.
--
-- Миграция написана вручную (не через `migrate dev`), чтобы не тянуть в неё
-- DROP INDEX для partial-unique индексов — см. «Известные грабли» в CLAUDE.md.
ALTER TABLE "IntegrationConnection" ADD COLUMN "tlsCredentialEnc" TEXT;
ALTER TABLE "IntegrationConnection" ADD COLUMN "tlsFingerprint" TEXT;
ALTER TABLE "IntegrationConnection" ADD COLUMN "tlsExpiresAt" TIMESTAMP(3);
