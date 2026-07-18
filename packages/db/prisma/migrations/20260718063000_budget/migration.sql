-- Бюджет: месячный лимит расходов (или план доходов) по категории.
CREATE TABLE "Budget" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Budget_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Budget_workspaceId_deletedAt_idx" ON "Budget"("workspaceId", "deletedAt");

-- Partial-unique: одна АКТИВНАЯ строка бюджета на категорию (soft-delete паттерн).
-- Как и остальные *_active_key — только в SQL, НЕ в schema.prisma (drift-грабли).
CREATE UNIQUE INDEX "Budget_workspaceId_categoryId_active_key"
    ON "Budget"("workspaceId", "categoryId")
    WHERE "deletedAt" IS NULL;

ALTER TABLE "Budget" ADD CONSTRAINT "Budget_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
