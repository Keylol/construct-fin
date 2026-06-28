# Аудит construct-fin — точка возобновления (resume)

Большая проверка фин-приложения. Эта записка — чтобы поднять контекст за минуту.
Создана 2026-06-24 при восстановлении прерванной сессии аудита.

## TL;DR

- **Фаза 1 (статический аудит) — ЗАВЕРШЕНА.** 29 единиц по 4 веткам, 176 файлов, 109 сырых
  находок → **62 подтверждено** адверсариальной верификацией. Все `real=true`.
- **Severity: Critical 0 · High 11 · Medium 19 · Low 32.** 11 High — это рабочий набор Фазы 4.
- Реестр: [`audit-phase1-registry.md`](audit-phase1-registry.md) (читаемый) +
  [`audit-phase1-registry.json`](audit-phase1-registry.json) (машинный, с вердиктами и голосами).

## Где что лежит (артефакты прошлой сессии)

| Что | Путь |
|---|---|
| Журнал workflow (полный кэш результатов) | `~/.claude/projects/-Users-alexander/1e96253f-5da0-4e5b-bb53-34bda2a17aa9/workflows/wf_0e9fad09-e95.json` |
| Скрипт workflow (29 единиц, схемы, промпты) | `~/.claude/projects/-Users-alexander-Documents-construct-fin/1e96253f-5da0-4e5b-bb53-34bda2a17aa9/workflows/scripts/construct-fin-audit-phase1-wf_0e9fad09-e95.js` |
| По-агентные журналы (220 шт.) | `…/1e96253f-…/subagents/workflows/wf_0e9fad09-e95/` |
| runId для resume | `wf_0e9fad09-e95` |

> **Re-run дёшево:** `Workflow({scriptPath, resumeFromRunId: "wf_0e9fad09-e95"})` — неизменённые
> `agent()`-вызовы вернутся из кэша мгновенно, повторно отработают только новые/изменённые.

## Статус фаз

| Фаза | Статус | Заметка |
|---|---|---|
| 0 — инфра + эталон | ✅ | ветка `audit/hardening` (текущая), 216 unit + 293 integration зелёные |
| 1 — статический аудит, 4 ветки | ✅ | 62 находки, реестр восстановлен (см. выше) |
| 2 — динамика | 🔄 частично | нагрузка дала **2 дефекта** (детали в транскрипте сессии 1e96253f — НЕ в журнале workflow, восстанавливать отдельно); Playwright готов, отложен |
| 3 — сводный реестр | ⏳ разблокирован | свести High+Medium в план фиксов; решить судьбу Low |
| 4 — фиксы + зелёный прогон | ⏳ ждёт Ф3 | чинить ≥High, прогнать тесты зелёными |

## Рабочий набор Фазы 4 — 11 High (все голоса 3/3)

| unit | файл:строка | суть |
|---|---|---|
| A6-export | `apps/api/src/reports/export/csv.ts:5` | CSV formula injection: `escapeCsv` не нейтрализует `= + - @ TAB CR` |
| B2-idempotency | `apps/api/src/common/idempotency.interceptor.ts:75` | кэш ответа пишется отдельной транзакцией после коммита — окно двойного денежного эффекта |
| B3-orders | `apps/api/src/orders/order.service.ts:59` | отрицательная скидка раздувает `totalAmount` |
| B3-orders | `apps/api/src/orders/order.service.ts:60` | скидка > subtotal → отрицательный `totalAmount`, ломает `paymentStatus` |
| C2/C8 | `apps/api/src/common/workspace.guard.ts:36` | `WorkspaceGuard` не проверяет `Workspace.deletedAt` — soft-deleted воркспейс рабочий |
| C6-import | `apps/api/src/import/parsers/values.ts:25` | `parseAmount` гонит деньги через float (`Number+toFixed`) — нарушение half-up |
| C6-import | `apps/api/src/import/parsers/values.ts:12` | эвристика разделителей даёт ошибку 1000× на US-формате `'1,234'` |
| D1-controllers | `apps/api/src/reports/reports.controller.ts:110` | экспорт CSV/XLSX сломан: `.strict()` отвергает query-параметр `format` |
| D2-hooks | `apps/web/src/hooks/useOrders.ts:78` | мутации заказа не инвалидируют reports/summary/warehouse — устаревшие деньги на экране |
| D4-pages | `apps/web/src/hooks/usePurchases.ts:41` | закупка не инвалидирует список/сводку операций |

Полный список с доказательством, последствием и предлагаемым фиксом по каждой — в реестре.
Сквозные темы Medium/High: TZ/R5 (UTC+5) в границах периодов и сверке (`period.ts`, `periods.ts`,
`reconciliation.service.ts`, `transaction.service.ts`); инвалидация React Query кэша (`useTransactions`,
`useImport`); деньги как JS number на фронте (`orders/page.tsx:742`).

## Открытые вопросы к Александру (на старте следующей сессии)

1. **Свои правки.** Что уже посмотрел/починил сам — что выкинуть из реестра, есть ли новые находки.
2. **2 дефекта нагрузки (Ф2)** — восстановить из транскрипта сессии 1e96253f?
3. **Скоуп Ф4** — только High (11), или + Medium (19)? На какой ветке (`audit/hardening` или новая `fix/audit-phase4`)?
4. **Эталон** для денежных фиксов (TZ/R5, float-парсер, COGS-в-number) — есть готовые числа/кейсы?

## Дизайн аудита (для воспроизведения)

4 ветки фокуса: **A** ядро/деньги (Decimal half-up, R1–R5, период UTC+5), **B** конкурентность
(FOR UPDATE под READ COMMITTED, идемпотентность, атомарность UoW), **C** безопасность/мультитенант
(Telegram HMAC+JWT, WorkspaceGuard cross-tenant, валидация zod, path traversal/инъекции),
**D** флоу/контракты/фронт (коды ответов, инвалидация кэша, неподключённые действия).
Каждая единица: review-агент (читает файлы целиком, выдаёт находки по схеме) → адверсариальные
верификаторы (refute-by-default, голосование). Подробности — в скрипте workflow.
