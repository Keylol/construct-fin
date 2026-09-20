-- «Ждут заказа» — явный набор этапов вместо порога «с этапа и дальше»: на доске
-- владельца сервисные этапы стоят после «Отправлен», а оплаченные в работе — до.

-- AlterTable
ALTER TABLE "CrmConnection" DROP COLUMN "triggerStatusId",
DROP COLUMN "triggerStatusSort",
ADD COLUMN     "waitingStatusIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[];

-- Перенос решения владельца (20.09.2026) на уже подключённые аккаунты: этапы
-- «оплаченные в работе» по именам из снимка наблюдаемой воронки. Снимка или
-- воронки нет — набор пуст (= любая открытая), владелец выберет в настройках.
UPDATE "CrmConnection" c
SET "waitingStatusIds" = COALESCE(
  (
    SELECT array_agg((s->>'id')::int ORDER BY (s->>'sort')::int)
    FROM jsonb_array_elements(c."pipelines") p,
         jsonb_array_elements(p->'statuses') s
    WHERE (p->>'id')::int = c."pipelineId"
      AND lower(s->>'name') IN ('уведомление по срокам', 'фото комплектующих', 'фото после сборки', 'оформление доставки', 'отправлен')
  ),
  ARRAY[]::INTEGER[]
)
WHERE c."deletedAt" IS NULL
  AND c."pipelineId" IS NOT NULL
  AND jsonb_typeof(c."pipelines") = 'array';
