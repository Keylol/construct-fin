-- Partial-unique индекс на импортные транзакции (Фаза 4 п.17).
-- Prisma не умеет partial-unique в схеме (@@unique глобален), поэтому индекс
-- заводится сырым SQL. Цель: один и тот же importHash не может задвоиться среди
-- АКТИВНЫХ транзакций воркспейса (защита от гонки/повторного импорта на уровне
-- БД — дополняет проверку дублей в import.service). Soft-deleted и строки без
-- importHash (ручной ввод) не участвуют.
--
-- ⚠️ Этот индекс НЕ отражён в schema.prisma — будущий `prisma migrate dev`
-- увидит его как drift. См. CLAUDE.md → «Известные грабли».
CREATE UNIQUE INDEX "Transaction_workspaceId_importHash_active_key"
  ON "Transaction" ("workspaceId", "importHash")
  WHERE "deletedAt" IS NULL AND "importHash" IS NOT NULL;