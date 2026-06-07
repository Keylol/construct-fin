# Construct v6 — план разработки: точность учёта + торговый домен

**Дата:** 2026-06-07
**Контекст:** генеральный план Фаз 0→5 (`docs/improvement-plan.md`) закрыт и подтверждён на проде. Цель — **рабочее бухгалтерское приложение перед скорым запуском**. Фокус: **точность кэш-флоу** (деньги через транзитные счета и счета физиков) + **торговый домен** (закупка→склад→заказ→маржа).

Хвост прошлого плана (ротация JWT_SECRET п.9, bot-token п.10) — отложен. Банковские API — **отложены**, на старте только ручной ввод + импорт Excel.

---

## Подтверждённые факты по коду

- **Складской поток:** закупка заводит на склад, заказ снимает.
  - `purchase.service.register()` → `Transaction(PURCHASE)` + `Purchase`/`PurchaseLine` + `warehouse.applyPurchaseLine()` (qty +=, WAVG).
  - Финализация заказа (→DONE) → `decrementForSale()` (qty -=, снапшот `unitCostAtSale`) + `Transaction(COGS)`.
  - ⚠️ Через склад идут только позиции с `WarehouseItem`; строки с ручным `unitCost` минуют склад.
- **Кэш-флоу — корень неточности:** `AccountType`=CASH/BANK/OTHER (нет «транзит/физик»); в `TransactionKind` нет `TRANSFER`. Перевод между своими счетами = две независимые транзакции → задваивает сводный оборот, пачкает P&L (bucket OTHER). Все qty-операции склада проходят через единственную точку — `warehouse.repository.ts`.

---

## Архитектура параллельной разработки

**Принцип:** сначала ОДНА волна со всеми изменениями схемы/миграций в `v6` (главный агент), потом фичи фан-аутом по полосам (lanes) — каждая в своём worktree, владеет своим набором файлов, не пересекается с другими.

**Жёсткие правила (из CLAUDE.md):**
- `schema.prisma`, миграции, `main.ts` — **только в `v6`, никогда параллельно**. Поэтому вся схема — в Волне 0.
- `app.module.ts` — общий: каждая новая полоса добавляет 1 строку импорта модуля. Эти строки мёржит **главный агент** (тривиальный конфликт по соседним строкам).
- Каждая полоса: ветка от `origin/v6` (после Волны 0 — `git rebase v6`) → PR → зелёный CI → Haiku-ревью → мёрж. В `v6` напрямую не пушить.
- ⚠️ При `migrate dev` убирать из SQL `DROP INDEX ..._active_key` (partial-unique заведены сырым SQL, Prisma видит drift).
- После миграции на проде — проверять ФАКТ БД (`migrate status`/индексы), `exec -T` в heredoc → `</dev/null`.

### Матрица владения файлами (чтобы агенты не конфликтовали)

| Полоса | Владеет файлами | Зависит от |
|---|---|---|
| **Волна 0 — Фундамент** (главный агент, `v6`) | `packages/db/prisma/schema.prisma`, миграции, `packages/db` | — |
| **A — Переводы и точный cashflow** | `apps/api/src/transfer/*` (новый модуль), `apps/api/src/reports/*` (cashflow.service, pnl.service, controller, dto, module) | Волна 0 |
| **B — Склад** | `apps/api/src/warehouse/*` (service, repository, controller, dto), `apps/api/src/common/wavg.ts`, новый парсер Excel-склада | Волна 0 |
| **C — Торговые отчёты** | `apps/api/src/trade-reports/*` (новый модуль: margin + receivables) | Волна 0 |
| **D — Сверка + детект переводов** | `apps/api/src/reconciliation/*` (новый), `apps/api/src/import/import.service.ts` + dto | A (Transfer API), 0 |
| **E — Возвраты клиента / RMA** | `apps/api/src/orders/*` | B (StockMovement), 0 |

Каждая полоса добавляет свой модуль в `app.module.ts` (1 строка) — мёржит главный агент.

---

## Волна 0 — Фундамент (главный агент, `v6`, СНАЧАЛА, последовательно)

Все изменения схемы — аддитивные, одной согласованной пачкой. После мёржа: `prisma generate`, билд `@construct/db` + `@construct/shared`, все полосы ребейзятся.

1. `enum AccountClass { OPERATING, TRANSIT, PERSONAL }` + `Account.class AccountClass @default(OPERATING)`.
2. Модель `Transfer { id, workspaceId, fromAccountId, toAccountId, amount, fee Decimal @default(0), date, note?, createdById, ... }`; в `TransactionKind` добавить `TRANSFER_IN`, `TRANSFER_OUT`; `Transaction.transferGroupId String?`.
3. Модель `StockMovement { id, workspaceId, warehouseItemId, type StockMovementType, qtyDelta, qtyAfter, unitCost?, refType?, refId?, reason?, createdAt, createdById }` + `enum StockMovementType { PURCHASE, SALE, RETURN_CUSTOMER, RETURN_SUPPLIER, ADJUSTMENT, WRITE_OFF, OPENING }`.
4. `WarehouseItem.reorderPoint Decimal?`.
5. Модель `AccountBalanceCheck { id, workspaceId, accountId, date, actualBalance, note?, createdById }` (для сверки).
6. `OrderItem.returnedQty` — уже есть, проверить, не добавлять.

---

## Волна 1 — параллельно, без взаимозависимостей (3 окна одновременно)

### Полоса A — Переводы и точный cashflow (ядро точности)
- Новый модуль `transfer/`: создать перевод → две связанные ноги (`TRANSFER_IN`/`TRANSFER_OUT`, общий `transferGroupId`); `fee` постится как расход (`VARIABLE_COST` — комиссия эквайринга/МП).
- `reports/pnl.service.ts`: исключить ноги переводов из P&L.
- `reports/cashflow.service.ts`: **консолидированный режим** (все `OPERATING`+`TRANSIT`+`PERSONAL` «наши» счета как один пул → переводы исчезают, остаётся внешний приток/отток) + режим «по счёту» оставить.
- Тесты: перевод не двигает P&L; консолидированный cashflow не задваивает.

### Полоса B — Склад (импорт Excel + журнал + точки заказа)
- **Импорт Excel-склада:** переиспользовать `parseGenericXlsx`; маппинг (SKU/название/qty/avgCost/ед.изм/reorderPoint) → preview → commit → `WarehouseItem` (начальные qty/avgCost) + `StockMovement(OPENING)`. Начальные остатки НЕ создают `Transaction` (cash-basis). + допил ручной формы (`warehouse.create`/`adjust`).
- **`StockMovement`:** писать движение внутри тех же UoW-методов `warehouse.repository.ts` (`applyPurchaseLine`, `decrementForSale`, `restock`, `adjust`, opening). Эндпоинт `warehouse.movements`.
- **`reorderPoint` + low-stock:** эндпоинт `warehouse.lowStock`.
- **Списания с причиной + возвраты поставщику:** `adjust()` с `reason` (поле `note` сейчас не используется); доварить `applySupplierReturn()` (`common/wavg.ts:73`, никем не вызывается) → `StockMovement(RETURN_SUPPLIER)` + транзакция-возврат.

### Полоса C — Торговые отчёты (read-only, отдельный модуль)
- Новый модуль `trade-reports/`: **маржа по товарам** (Σ qty·price − Σ qty·`unitCostAtSale` по DONE-заказам, маржа %) и **по клиентам** (группировка по `clientId`).
- **Дебиторка** (кто мне должен): агрегация `Order.paymentStatus`/`paidAmount`, aging-корзины (0-30/30-60/60+).
- Кредиторка — позже (нужен payment-статус у `Purchase`).

---

## Волна 2 — параллельно, зависят от Волны 1 (после мёржа A и B)

### Полоса D — Сверка + авто-подсказка переводов (зависит от A)
- Новый модуль `reconciliation/`: ввод фактического остатка на дату (`AccountBalanceCheck`) + вьюха «расчётный vs фактический» с расхождением и списком несведённых операций.
- `import/import.service.ts`: в preview искать пары-кандидаты переводов (та же сумма, противоположный знак, близкие даты, оба «наши») → отдавать как suggestion; создание перевода вызывает API Полосы A.

### Полоса E — Возвраты клиента / частичная отгрузка (зависит от B)
- `orders/`: задействовать `OrderItem.returnedQty` — частичный возврат от клиента → `restock` + `StockMovement(RETURN_CUSTOMER)` + `Transaction(ORDER_REFUND)`; частичная отгрузка.

---

## Очередность

Волна 0 (Фундамент, главный агент) → Волна 1 (A‖B‖C параллельно) → Волна 2 (D‖E параллельно).
Главный агент: делает Фундамент, ребейзит полосы, ревьюит PR (Haiku), мёржит по очереди, разрешает мини-конфликты `app.module.ts`.
</content>
