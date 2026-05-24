# Импорт банковских выписок

Construct v6 умеет импортировать транзакции из CSV/Excel/PDF-выписок. Этап ввода данных вручную больше не обязателен.

## Поддерживаемые форматы

| Источник | Парсер | Когда используется |
|---|---|---|
| Альфа-Банк xlsx | `parseAlfaXlsx` | Имя файла содержит `alfa` / `альфа` И расширение `.xlsx` |
| Wildberries pdf | `parseWbPdf` | Имя файла содержит `wb` / `wildberries` / `вб` И `.pdf` (либо просто `.pdf` без других совпадений) |
| Универсальный xlsx | `parseGenericXlsx` | Любой `.xlsx`, кроме банковских |
| Универсальный csv | `parseGenericCsv` | Любой `.csv` |
| Т-Банк pdf | заглушка | Парсер не написан до появления фикстуры |

Детектор: `apps/api/src/import/parsers/detector.ts`.

## Архитектура

```
POST /workspaces/:wsId/import/preview   (multipart, file + ?accountId)
   ↓ выбор парсера по filename
   ↓ парсинг → ParsedRow[] с date/amount/type/counterparty/description
   ↓ резолв counterparty по имени (case-insensitive)
   ↓ хэширование строк → importHash
   ↓ запрос Transaction.findMany по importHash → маркер isDuplicate
   ← PreviewResult { source, headers, rows, stats, fileHash }

POST /workspaces/:wsId/import/commit
   body: { source, accountId, filename, fileHash, skipDuplicates, rows[] }
   ↓ Prisma $transaction:
   ↓   создать недостающие Counterparty
   ↓   создать ImportBatch
   ↓   создать Transaction[] с importBatchId + importHash
   ← { batchId, imported, skipped }

POST /workspaces/:wsId/import/batches/:batchId/rollback
   ↓ soft-delete всех Transaction в batch + ImportBatch.deletedAt = now()
   ← { rolledBack }
```

## Дедупликация

`importHash = sha256(workspaceId + accountId + date(YYYY-MM-DD) + amount + type + counterparty.lower + description.lower.slice(80))`

Хеш считается на этапе preview. Дубль = транзакция с тем же `importHash` и `deletedAt IS NULL`.

После rollback дубли освобождаются: soft-deleted транзакции не учитываются при следующем preview.

## Кодировка CSV

`detectEncoding` использует `jschardet` на первых 64 КБ файла. `iconv-lite` декодирует. Если кодировка не определена — fallback на utf-8.

Тестовое покрытие: cp1251 → автодетект, utf-8 → автодетект.

## Авто-создание контрагентов

На commit для каждого уникального `counterpartyName` ищется существующий Counterparty по имени (case-insensitive). Если есть → используется его id. Если нет → создаётся новый в той же транзакции.

## Откат пакета

`POST /import/batches/:batchId/rollback`:
- `Transaction.deletedAt = now()` для всех транзакций пакета
- `ImportBatch.deletedAt = now()`
- Список `/import/batches` показывает «откатан» вместо «активен»; кнопка отката скрыта.

После rollback пакет нельзя восстановить — нужно импортировать заново (дубли не сработают, т.к. soft-deleted строки не учитываются).

## Как добавить парсер под новый банк

1. Положить фикстуру в `fixtures/imports/<bank>-sample.<ext>`
2. Создать `apps/api/src/import/parsers/<bank>.ts` — функцию вида `(buffer: Buffer) => ParseResult`
3. Добавить в `apps/api/src/import/parsers/index.ts`
4. Добавить ветку в `detector.ts` (по имени файла) + в `ImportService.runParser` (switch)
5. Добавить значение в enum `ImportSource` в Prisma schema + миграция
6. Юнит-тест в `parsers.test.ts` против фикстуры

## Что НЕ делает импорт

- Не назначает категории (фаза 4 — авто-маппинг по ключевым словам)
- Не редактирует counterparty после создания
- Не парсит сканы PDF (нужен OCR — отложено)
- Не объединяет несколько файлов в один пакет
- Не валидирует валюту (только ₽)
