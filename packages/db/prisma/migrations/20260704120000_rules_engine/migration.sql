-- Конфигурируемость Блок 1: движок правил «условие → действие» (обобщение
-- CategoryRule). conditions/actions — JSONB из фиксированного zod-словаря
-- (rule.dto.ts); id внутри JSON валидируются на принадлежность workspace в сервисе.

-- CreateTable
CREATE TABLE "Rule" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "appliesTo" TEXT NOT NULL DEFAULT 'BOTH',
    "conditions" JSONB NOT NULL,
    "actions" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Rule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Rule_workspaceId_isActive_priority_idx" ON "Rule"("workspaceId", "isActive", "priority");

-- CreateIndex
CREATE INDEX "Rule_workspaceId_deletedAt_idx" ON "Rule"("workspaceId", "deletedAt");

-- AddForeignKey
ALTER TABLE "Rule" ADD CONSTRAINT "Rule_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
