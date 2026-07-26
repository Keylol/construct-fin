-- Ф2 «Альфа»: идентификатор счёта на стороне провайдера (у Альфы — номер
-- расчётного счёта, обязательный параметр запроса выписки). Nullable: у
-- FakeBank/WB_CARD его нет, существующие подключения не ломаются.
--
-- Миграция написана вручную (не через `migrate dev`), чтобы не тянуть в неё
-- DROP INDEX для partial-unique индексов, заведённых сырым SQL и отсутствующих
-- в schema.prisma — см. «Известные грабли» в CLAUDE.md.
ALTER TABLE "IntegrationConnection" ADD COLUMN "externalAccountId" TEXT;
