-- Удаление deprecated таблицы CategoryRule.
-- Заменена движком правил (model Rule) в Фазе C (PR #73). На проде таблица пуста
-- (сверено 2026-07-05: 0 строк), данные не теряются. FK CategoryRule→Workspace/
-- Category и оба индекса дропаются автоматически вместе с таблицей.
DROP TABLE "CategoryRule";
