# Карта архитектуры construct-fin

> Синтез шести разрезов кодовой базы (schema, tx-writers, orders-warehouse, reports, http-guards, frontend), 2026-07-02.
> Назначение: опорный документ для поблочного аудита. Здесь факты и их стыковка, не выводы.
> Пути — от корня репозитория. Номера строк — на момент разрезов, могут дрейфовать.

## 0. Обзор

Monorepo: `apps/api` (NestJS + Fastify + Prisma), `apps/web` (Next.js App Router + react-query), `packages/db` (schema.prisma — 911 строк, 23 модели, 23 миграции), `packages/shared` (money на decimal.js-light, telegram-схемы).

Три несущие идеи:
1. **`Transaction` — единая шина денег.** Все домены (orders, purchases, warehouse, transfers, import, generic CRUD) пишут в одну таблицу, различаясь полем `kind`; все отчёты — производные от неё через exclusion-списки `apps/api/src/common/transaction-kinds.ts`.
2. **Истина по складу — партии FIFO** (`StockLot` + append-only `LotConsumption`), всё остальное (`WarehouseItem.qty/avgCost`, `Order.paidAmount`, `OrderItem.unitCostAtSale`) — derived-кэши, пересчитываемые в той же транзакции, что и истина.
3. **Тенантность через путь**: все доменные эндпоинты — `/workspaces/:wsId/...` за `JwtAuthGuard → WorkspaceGuard`; каждый запрос к БД обязан дублировать `workspaceId` в where. Кэшей приложения нет — отчёты пересчитываются на каждый запрос.

```
 Frontend (apps/web, react-query) ──/api/v1 (nginx | Next rewrite)──▶ API (Nest+Fastify)
                                          guards: JwtAuth → Workspace → ZodPipe
     ┌──────────┬──────────────┬─────────────────┬──────────────┬───────────┐
   Orders    Purchases      Warehouse-FIFO    Transfers       Import    Справочники
     │ FIFO-вызовы │  applyPurchaseLine │           │             │       (валид. ссылок)
     │◀────────────┴────────────────────┘           │             │
     ▼              ▼                   ▼           ▼             ▼
 [Order,Item,   [Purchase,        [StockLot,    [Transfer]   [ImportBatch]
  Schedule]      PurchaseLine]     LotConsumption,
     │              │              StockMovement]│             │
     └──────────────┴────────── Transaction (шина денег) ──────┴──────────────┐
                                     ▲                                        │
      Reports / Trade-reports / Reconciliation / Dashboard-summary (read-only)┘
 Infra: UnitOfWork + ALS commit-hooks, IdempotencyInterceptor, AuditLog,
        Attachment-хранилище, AllExceptionsFilter, конфиг/деплой
```

---

## 1. Функциональные блоки (12)

### 1.1 Auth / Workspace

**Назначение.** Вход тремя путями (Telegram Login Widget, Mini App initData, пароль) → JWT в HTTP-only cookie `construct_jwt`; членство/роль в workspace; CRUD workspace. Роли НЕ энфорсятся нигде, кроме PATCH/DELETE workspace (осознанная плоская модель).

**Ключевые файлы.** `apps/api/src/auth/{auth.controller,auth.service,telegram-verify,jwt.guard,jwt-ttl}.ts`, `current-user.decorator.ts`; `apps/api/src/workspace/{workspace.controller,workspace.service,workspace.dto}.ts`; `apps/api/src/common/{workspace.guard,current-workspace.decorator}.ts`; `packages/shared/src/telegram.ts`; env — `apps/api/src/config.ts` (JWT_SECRET min16, JWT_EXPIRES_IN 7d, TELEGRAM_ALLOWED_IDS csv→bigint[], AUTH_PASSWORD_HASH optional).

**Пишет.** `User` (upsert по `telegramId` на каждом входе), `Workspace`, `WorkspaceMember` (составной PK `[workspaceId,userId]`).

**Контракты наружу.**
- HTTP: `POST /auth/telegram/{widget,miniapp}`, `POST /auth/login` (все три — единственные под ThrottlerGuard, 10/60с), `GET /auth/me`, `POST /auth/logout` (без auth, clearCookie); `GET|POST|PATCH|DELETE /workspaces[...]` (PATCH — OWNER/ADMIN, DELETE — OWNER, инлайн requireRole).
- Внутрь стека: `req.user = {sub, tg}` (JwtAuthGuard: Bearer приоритетнее cookie), `req.workspace = {workspaceId, userId, role}` (WorkspaceGuard: wsId ТОЛЬКО из `req.params.wsId`; один prisma-запрос членство+`workspace.deletedAt`; не член → 403, удалён → 403). Верификация Telegram: HMAC + `timingSafeEqual`, окна свежести 1ч (widget) / 15мин (miniapp); пустой allowlist = вход всем (warn).
- Серверной инвалидации токенов/refresh нет; logout = clearCookie.

### 1.2 Справочники (Accounts, Categories, Counterparties, CategoryRules)

**Назначение.** Опорные сущности денег и торговли: счета (тип CASH/BANK/OTHER + бух-класс `AccountClass` OPERATING/TRANSIT/PERSONAL — все три «наш» пул, переводы между ними не приток/отток), категории (иерархия ≤2 уровней, P&L-бакет `CategoryBucket`), единый контрагент с ролью-дискриминатором (CLIENT/SUPPLIER/EMPLOYEE/OTHER), правила автокатегоризации импорта (keyword+priority).

**Ключевые файлы.** `apps/api/src/account/*`, `apps/api/src/category/*`, `apps/api/src/counterparty/*`, `apps/api/src/category-rule/*` (controller/service/dto каждого).

**Пишет.** `Account`, `Category`, `Counterparty`, `CategoryRule` — все с soft-delete.

**Контракты наружу.**
- HTTP CRUD: `/workspaces/:wsId/{accounts,categories(+/tree),counterparties,category-rules}`.
- Вниз по стеку: `Account.openingBalance` — база cashflow/reconciliation; `Category.bucket` — база P&L; `Counterparty` — клиент заказа / поставщик закупки и лота; `CategoryRule` — вход автокатегоризации импорта.
- Уникальность per-workspace — partial-unique только в SQL миграций (`_active_key`, WHERE deletedAt IS NULL): Account(name), Counterparty(inn), Category(ws, COALESCE(parentId,''), name, kind — expression-index против NULL≠NULL), миграция `20260616035907_ref_partial_unique`.
- Потребители-валидаторы: `TransactionService.validateRefs`, `PurchaseService.assertRefs`, `OrderService.assertOrderRefs/assertAccount` — все pre-tx `findFirst(ws, deletedAt: null)`, без лока (см. §4 N-15). `AccountService.softDelete` — guard по count транзакций счёта. Transfer лочит счета `FOR UPDATE` (живые + `isArchived=false`).

### 1.3 Transactions-шина (generic CRUD + классификация kind)

**Назначение.** Единая таблица движений денег. Generic CRUD — только для ручных kind; системные kind создают доменные блоки; здесь же dashboard-summary. Соответствие `type↔kind` валидируется только на сервисе — БД не проверяет.

**Ключевые файлы.** `apps/api/src/transaction/{transaction.controller,transaction.service,transaction.dto}.ts`; `apps/api/src/common/transaction-kinds.ts`; модель — `packages/db/prisma/schema.prisma:640–730`.

**Пишет.** `Transaction` c ручными kind: INCOME → `CAPITAL_IN, OTHER`; EXPENSE → `SALARY, TAX, FIXED_COST, VARIABLE_COST, NON_OP, CAPITAL_OUT, OTHER` (`MANUAL_KINDS_BY_TYPE`, transaction.dto.ts:19). Update/softDelete чужих системных kind блокирует `SYSTEM_KINDS` (transaction.service.ts:18): `ORDER_PAYMENT, ORDER_REFUND, COGS, PURCHASE, SUPPLIER_REFUND, WRITE_OFF` — **TRANSFER_IN/OUT в списке НЕТ** (§4 N-6).

**Контракты наружу.**
- HTTP: `GET|POST /transactions`, `GET /transactions/summary` (kind notIn `NON_CASH_CONSOLIDATED`; from/to опциональны независимо), `GET|PATCH|DELETE /transactions/:id`.
- Таблица = интеграционная точка всех блоков. Схема: `type` (быстрые агрегаты INCOME/EXPENSE) + `kind` (бух-классификация), сторно через `originalTxId`, ноги переводов через `transferGroupId`, импорт через `importBatchId/importHash` (partial-unique `Transaction_workspaceId_importHash_active_key`). Физического delete нет нигде — только `deletedAt`.
- Особенности write-path: create/update/delete — **без транзакции БД вообще**; аудит только у update/delete и **post-hoc вне tx** (ошибка глотается); create — без аудита; `validateRefs` pre-tx без лока.
- Exclusion-списки для всех читателей: `TRANSFER_LEG_KINDS`, `NON_CASH_KINDS=[COGS,WRITE_OFF]`, `NON_CASH_FOR_ACCOUNT` (=NON_CASH), `NON_CASH_CONSOLIDATED` (=TRANSFER_LEG+NON_CASH).

### 1.4 Orders-ядро

**Назначение.** Жизненный цикл заказа-продажи `OPEN → DONE | CANCELLED`: строки (товар со склада / услуга), оплаты (в т.ч. рассрочка gross, F3), план-график платежей (F2), частичная отгрузка, возвраты, finalize (атомарно: FIFO-списание склада + COGS ручных позиций + снапшоты себестоимости), реверсы (cancel/reopen/delete).

**Ключевые файлы.** `apps/api/src/orders/{order.controller,order.service,order.repository,order.dto}.ts`.

**Пишет.** `Order` (вкл. кэши subtotal/totalAmount/paidAmount/paymentStatus/closedAt), `OrderItem` (qty/shippedQty/returnedQty/unitCost/unitCostAtSale/lineTotal), `PaymentScheduleEntry` (replace-all: hard deleteMany + createMany); `Transaction`: `ORDER_PAYMENT` (addPayment, installment), `VARIABLE_COST` (комиссия рассрочки), `ORDER_REFUND`, `COGS` (finalize — одна проводка на ручные позиции; частичное отрицательное сторно при возврате ручной позиции c `originalTxId`; гашение updateMany в reverseFinalization; remove гасит ВСЕ проводки заказа).

**Контракты наружу.**
- HTTP: `GET /orders[,:id,:id/trace]`, `POST /orders`, `PATCH /:id`, `POST /:id/{payments,installment-payment,ship,returns,finalize,reopen,cancel}`, `PUT /:id/schedule`, `DELETE /:id` (возвращает 200 с телом).
- Внутренний API: `recalcPaymentState(ws, orderId, tx)` — публичная обёртка для Import; `syncPaymentState`: `paidAmount = Σ живых ORDER_PAYMENT − Σ ORDER_REFUND` → `paymentStatus` (`resolvePaymentState`: paid<0→REFUNDED; total=0→PAID/OVERPAID; …).
- Дисциплина: каждая мутация начинается с `lockAndLoad` (row `FOR UPDATE` на Order, order.repository.ts:73–79) + свежее чтение под локом; мульти-SKU операции сортируются `sortItemsForLocking` (warehouseItemId ASC, услуги в конец); COGS-счёт — `resolveCostAccount` (счёт последней ORDER_PAYMENT → первый активный → 400). Идемпотентность на уровне приложения: повторный finalize DONE и cancel CANCELLED — early return. Складские позиции COGS-проводку НЕ создают (расход признан PURCHASE-проводкой закупки) — только снапшот `unitCostAtSale`.
- Правила: replace items запрещён при ∃ shippedQty>0; discount ≤ subtotal; qty-CHECKи в БД (`20260615211446`); ретрай номера заказа при P2002 ×5.

### 1.5 Витрины заказа (derived read-model)

**Назначение.** Вычисляемое представление заказа, собираемое на КАЖДЫЙ ответ get/мутации (`serializeOrder`, order.service.ts:94–125): маржа по строке и заказу, каскад источника себестоимости, представление графика платежей с FIFO-покрытием и просрочкой, трасса партий (F5). Ничего не хранит.

**Ключевые файлы.** `apps/api/src/orders/order-margin.ts`, `apps/api/src/orders/payment-schedule.ts`, `apps/api/src/common/margin.ts` (marginPct), `apps/api/src/warehouse/warehouse.service.ts:419–468` (`lotTraceForOrder`).

**Пишет.** Ничего (чистые функции + read-only чтения).

**Контракты наружу.**
- Каскад себестоимости для маржи: `unitCostAtSale` (actual) → `unitCost` (manual) → `warehouseItem.avgCost` (estimate, поле costSource) → 0; `netQty = qty − returnedQty` clamp ≥0.
- `scheduleView`: FIFO-покрытие `max(paidAmount,0)` по строкам (dueDate, seq, id); просрочка строки — после `endOfDay(dueDate)` в бизнес-TZ UTC+5 (`reports/period.ts`); `Σ строк ≠ totalAmount` — мягкое предупреждение, не ошибка.
- `GET /orders/:id/trace` → `lotTraceForOrder`: `prisma.orderItem/lotConsumption` include lot/supplier/account, вне транзакции, net-агрегация в памяти.
- Потребители: фронт (orders/page.tsx), receivables (та же логика payment-schedule для overdueByPlan).

### 1.6 Warehouse-FIFO

**Назначение.** Складской учёт партиями FIFO (F0, WAVG→FIFO): истина — `StockLot` (+ append-only леджер `LotConsumption` со снимком unitCost), журнал — append-only `StockMovement`; `WarehouseItem.qty/avgCost` — derived-кэши. Операции: opening, приход закупки, списание продажи, реверсы возвратов, инвентаризация (adjust), списание в убыток (write-off, F4), возврат поставщику, инициализация себестоимости (set-cost), складской импорт.

**Ключевые файлы.** `apps/api/src/warehouse/{warehouse.controller,warehouse.service,warehouse.repository,warehouse.dto}.ts`; `apps/api/src/common/fifo.ts` (чистая математика: `consumePlan` — жадный FIFO с `InsufficientStockError`, `reversePlan` — жадный LIFO по снимочным ценам с `InsufficientReversibleError`, `weightedUnitCost`); модели — `schema.prisma:431–627`; миграции `20260628121756_f0_fifo_lots` (CHECKи + `StockLot_open_fifo_idx`), `20260628130000_f0_fifo_backfill` (MIGRATION-лоты + RAISE EXCEPTION при расхождении qty↔Σлотов).

**Пишет.** `WarehouseItem` (вкл. кэши), `StockLot`, `LotConsumption` (append-only, qty знаковая: +CONSUME/−REVERSAL), `StockMovement` (append-only); `Transaction`: `WRITE_OFF` (EXPENSE, **неденежная**, счёт = «технический» первый активный, при loss=0 проводка не создаётся), `SUPPLIER_REFUND` (INCOME, cash; расхождение с лотовой стоимостью проводки не имеет).

**Контракты наружу.**
- HTTP: `GET /warehouse[,:id,:id/lots,:id/movements,stock-value,low-stock]`, `POST /warehouse[, /:id/{adjust,set-cost,write-off,supplier-return}]`, `POST /import/{preview,commit}` (складской импорт → openingLot), `PATCH /:id`, `DELETE /:id` (200).
- Внутренний API для Orders/Purchases (все принимают `tx` и обязаны жить в UoW вызывающего): `decrementForSale` (SALE + CONSUME с orderItemId), `reverseConsumption` (RETURN_CUSTOMER + REVERSAL в те же лоты по снимочной цене; `NoConsumptionsError` если потреблений нет), `restock` (fallback: новый RETURN_CUSTOMER-лот в хвост FIFO; item soft-deleted → движение без лота), `unitCostAtSaleFor` (= netCost/netQty net-леджера, 4dp, null при netQty≤0 — ЕДИНСТВЕННЫЙ источник `OrderItem.unitCostAtSale` складских позиций), `applyPurchaseLine`, `openingLot`.
- Дисциплина: якорь сериализации SKU = row-lock `WarehouseItem` (repo `lockForUpdate`), берётся первым в каждом tx-методе; `lockOpenLots` — `FOR UPDATE` лотов строго в FIFO-порядке (receivedAt ASC, seq ASC); `recomputeCaches` после каждой лот-операции под тем же локом; supplierReturn переупорядочивает лоты (свой поставщик → остальные) после взятия локов.

### 1.7 Purchases

**Назначение.** Закупка на склад, cash-basis: деньги списываются сразу одной PURCHASE-проводкой, себестоимость входит партиями; продажа складского товара второй раз расходом не признаётся. Реверса закупки нет (компенсация — supplier-return склада).

**Ключевые файлы.** `apps/api/src/purchase/{purchase.controller,purchase.service}.ts` (+dto).

**Пишет.** `Purchase` (1:1 `transactionId @unique`, FK Cascade), `PurchaseLine`; `Transaction` (kind `PURCHASE`, EXPENSE, amount = Σ `money(qty×unitPrice)`); через `WarehouseService.applyPurchaseLine` — `StockLot` (sourceType PURCHASE, lotMeta: purchaseLineId/supplierId/accountId/receivedAt=дата закупки; бэкдейт разрешён с logger.warn), `StockMovement`, кэши `WarehouseItem`.

**Контракты наружу.** `GET /purchases[,:id]`, `POST /purchases` (фронт шлёт Idempotency-Key). Порядок внутри одного `uow.run`: Transaction → Purchase → per-line (sorted warehouseItemId ASC) PurchaseLine + applyPurchaseLine → `audit.record('purchase.register')` в tx. `assertRefs` (счёт/поставщик) — pre-tx, без in-tx перепроверки; warehouseItemId валидируется локом внутри applyPurchaseLine.

### 1.8 Import (банковские выписки)

**Назначение.** Импорт выписок (GENERIC_CSV/GENERIC_XLSX/ALFA_XLSX/TINKOFF_PDF/WB_PDF): preview (парсинг+маппинг) → commit батчем; автосоздание контрагентов по lowercase-имени, автокатегоризация по CategoryRule, привязка INCOME-строк к заказам.

**Ключевые файлы.** `apps/api/src/import/{import.controller,import.service}.ts` (+парсеры, dto); модель `ImportBatch`.

**Пишет.** `ImportBatch`, `Transaction` (createMany: привязанная к заказу строка → `ORDER_PAYMENT`+orderId, иначе kind не задаётся → БД-дефолт `OTHER`; counterpartyId привязанных = order.clientId как есть), `Counterparty` (авто-создание), `Order.paidAmount/paymentStatus` — через `OrderService.recalcPaymentState` по каждому привязанному заказу в той же tx.

**Контракты наружу.**
- HTTP: `POST /import/preview` (multipart, ручной лимит `MAX_IMPORT_BYTES=10MB`, mapping — JSON в query), `POST /import/commit`, `GET /import/batches`. Undo батча НЕТ.
- Защита от повтора — своя, не Idempotency-Key: fileHash батча → 409 + partial-unique `(workspaceId, importHash)` WHERE deletedAt IS NULL → откат.
- ВАЖНО: commit идёт через сырой `prisma.$transaction` (import.service.ts:412), НЕ через UnitOfWork → `drainCommitHooks` не вызывается (§4 N-16). Один accountId на весь батч, проверен до tx; внутри tx — TOCTOU-перепроверка заказов.
- Складской импорт — НЕ этот блок (живёт в WarehouseService.importPreview/importCommit).

### 1.9 Reports (P&L, Cashflow, Breakdown, Export)

**Назначение.** Финансовая отчётность поверх шины Transaction: P&L по бакетам с comparison (prev/yoy/custom — только у P&L), cashflow (consolidated и by-account, opening + running balance), разбивки by-category/by-counterparty, экспорт CSV/XLSX.

**Ключевые файлы.** `apps/api/src/reports/{reports.controller,reports.dto,pnl.service,cashflow.service,breakdown.service}.ts`, `apps/api/src/reports/period.ts` (бизнес-TZ = фиксированный UTC+5, пресеты, дефолт this-month), `apps/api/src/reports/export/{builders,csv,xlsx,report-table,index}.ts`.

**Пишет.** Ничего (read-only; кэшей приложения нет — каждый запрос с нуля).

**Контракты наружу.**
- HTTP: `GET /reports/{pnl,cashflow,by-category,by-counterparty}`, `GET /reports/:kind/export?format=csv|xlsx` (query парсится вручную схемой kind, format вырезается — схемы `.strict()`).
- Правила чтения: только `Transaction.date` + `deletedAt IS NULL`; kind-исключения: P&L — только TRANSFER_* (COGS и WRITE_OFF ВКЛЮЧЕНЫ как расход бакета COGS); cashflow consolidated / breakdown / dashboard-summary — `NON_CASH_CONSOLIDATED`; cashflow by-account — `NON_CASH_FOR_ACCOUNT` (ноги переводов включены). Бакет: `Category.bucket`, для строк без категории — `bucketForSystemKind(kind)` (pnl.service.ts:283–307; ORDER_REFUND→REVENUE контр-выручкой, SUPPLIER_REFUND→PURCHASES).
- SQL-группировка по времени: `date_trunc('month'|'quarter', "date" + interval '5 hours')` — жёсткий +5, не именованная зона.
- Формулы P&L: grossProfit = (income − CAPITAL.income) − COGS-бакет; net = (income−CAPITAL.income) − (expense−CAPITAL.expense). Cashflow opening = Σ openingBalance живых счетов + prior-обороты.
- Экспорт переиспользует сервисы отчётов (отдельного чтения БД нет); PnL-export всегда `comparison: null`; в шапке период печатается `toISOString().slice(0,10)` — UTC-дата инстанта (§4 N-13).

### 1.10 Trade-reports + Reconciliation + Transfers

**Назначение.** Торговая аналитика (маржа by-product/by-client по снапшотам себестоимости; дебиторка с aging и просрочкой по плану), сверка остатков счетов (книжный vs фактический, append-only снимки), переводы между своими счетами (2 ноги + комиссия — единственный write-side в тройке).

**Ключевые файлы.** `apps/api/src/trade-reports/{margin.service,receivables.service,trade-reports.controller,trade-reports.dto}.ts`; `apps/api/src/reconciliation/{reconciliation.controller,reconciliation.service,reconciliation.dto}.ts`; `apps/api/src/transfer/{transfer.controller,transfer.service}.ts`.

**Пишет.** `Transfer` + `Transaction`-ноги: OUT=EXPENSE/`TRANSFER_OUT` (from-счёт), IN=INCOME/`TRANSFER_IN` (to-счёт), fee>0 → EXPENSE/`VARIABLE_COST` (from-счёт), все с `transferGroupId = Transfer.id`; softDelete гасит все ноги updateMany по transferGroupId. `AccountBalanceCheck` — append-only, БЕЗ deletedAt, удаление физическое. Trade-reports не пишут ничего.

**Контракты наружу.**
- Margin: `GET /trade-reports/margin/{by-product,by-client}` — читает `OrderItem`+`Order(status DONE)`, период по `Order.closedAt`, БЕЗ периода = вся история; cogs = netQty·(`unitCostAtSale ?? unitCost ?? 0`); Transaction не читается; Counterparty для имён — без deletedAt-фильтра (§4 N-10).
- Receivables: `GET /trade-reports/receivables?asOf` — Order UNPAID/PARTIAL, due = totalAmount − paidAmount, aging по `Order.createdAt` (корзины <30/<60/60+), overdueByPlan по `PaymentScheduleEntry.dueDate` через scheduleView; периода нет; asOf — сырой Date без endOfDay (§4 N-12).
- Reconciliation: `GET /reconciliation?accountId&asOf` — computedBalance = openingBalance + Σ INCOME − Σ EXPENSE (kind notIn `NON_CASH_FOR_ACCOUNT`, т.е. переводы ПО СЧЁТУ включены); discrepancy = actual − computedAtCheck; несведённые операции после снимка — БЕЗ kind-фильтра вовсе (§4 N-8); `POST|DELETE /reconciliation/checks`.
- Transfers: `POST /transfers` — `lockAndAssertAccounts` `SELECT…FOR UPDATE` обеих строк Account (живые, неархивные, ORDER BY id — анти-deadlock) в UoW; `DELETE /:id`; date пишется сырым `new Date(input.date)`. Аудита в TransferService нет вообще.

### 1.11 Frontend (apps/web)

**Назначение.** Next.js-клиент: все данные через react-query поверх fetch-обёртки; деньги — строки DTO; точная арифметика Decimal — локально в заказах/импорте; SSR-gate аутентификации.

**Ключевые файлы.** `apps/web/src/lib/{api.ts,query-client.ts,types.ts}`; `apps/web/src/hooks/use*.ts` (Orders/Transactions/Warehouse/Purchases/Transfers/Import/Accounts/Categories/CategoryRules/Counterparties/Reports/TradeReports/Reconciliation/Workspaces/Audit/CurrentWorkspace); страницы `apps/web/src/app/(app)/*`; `apps/web/src/app/(app)/layout.tsx` (ensureAuthed), `app/login/page.tsx`; `packages/shared/src/money.ts` (decimal.js-light, ROUND_HALF_UP).

**Пишет.** Ничего своего (всё через API); локально — `localStorage construct.currentWorkspaceId`.

**Контракты наружу (к API).**
- Транспорт: `BASE='/api/v1'` (prod — nginx `location /api/v1/ → 127.0.0.1:4000/`; dev — Next rewrite), `credentials:'include'`; не-2xx → `ApiError(status, body, message)`; 4 пути мимо обёртки (сырой fetch): multipart-вложения заказа/транзакции, import preview, login.
- Кэш-политика: глобально staleTime 30s / retry 1 / без refetchOnWindowFocus; мутации retry 0; optimistic updates нет — только invalidateQueries наборы: ORDERS-SET, WH-SET, TX-SET, CASH-SET (`['reports']/['trade-reports']/['reconciliation']` гасятся без wsId — префикс-матч).
- Идемпотентность: `Idempotency-Key` (uuid в onMutate + useRef, паттерн M18) шлют РОВНО 4 мутации: createPurchase, addOrderPayment, addInstallmentPayment, finalizeOrder.
- Ошибки/401: глобальной обработки нет (ни QueryCache.onError, ни interceptor); формы — try/catch → инлайн; toast.success 9 мест, toast.error нигде; 401 ловится только SSR-gate `ensureAuthed()` (нет cookie или `/auth/me` не ok → redirect /login); протухший JWT в живой сессии → тихий error-state (§4 N-21).
- Деньги: Decimal-арифметика — orders/page.tsx (итоги черновика, скидка/остаток, график) и import/page.tsx; Number()-float на деньгах — warehouse/page.tsx:44,615, страницы reports/* (§4 N-19).

### 1.12 Infra (обвязка API, хранилище файлов, аудит, деплой)

**Назначение.** Bootstrap и сквозные механизмы: UoW + ALS commit-хуки, глобальная идемпотентность, фильтр ошибок, Zod-валидация, троттлинг логина, вложения, журнал аудита, health, конфиг, nginx, миграционная дисциплина.

**Ключевые файлы.** `apps/api/src/main.ts` (FastifyAdapter `trustProxy:1`, cookie, multipart `fileSize=MAX_UPLOAD_SIZE_MB*1MB, files:1`, глобальные Filter+Interceptor), `apps/api/src/app.module.ts` (ThrottlerModule 10/60с, провайдеры), `apps/api/src/config.ts` (Zod fail-fast env); `apps/api/src/common/{unit-of-work,transactional-context,idempotency.interceptor,zod-pipe,all-exceptions.filter,money,transaction-kinds}.ts`; `apps/api/src/audit/{audit.service,audit.controller}.ts`; `apps/api/src/attachment/{attachment.controller,attachment.service,file-validation}.ts`; `apps/api/src/health/health.controller.ts`; `deploy/nginx/construct-v6.conf`; `packages/db/prisma/{schema.prisma,migrations/}`.

**Пишет.** `IdempotencyKey` (key=PK, глобальная, НЕ ws-scoped, TTL 24ч, lease 10мин), `AuditLog` (workspaceId/actorId nullable, diff Json), `Attachment` (полиморфно transactionId ИЛИ orderId; файлы `<UPLOAD_DIR>/<wsId>/<sha256[0:2]>/<sha256>`, дедуп по hash per-workspace, allowlist PDF/JPEG/PNG/WEBP/HEIC/HEIF + магические байты).

**Контракты наружу.**
- `UnitOfWork.run(fn)` = `prisma.$transaction(fn, {maxWait:5000, timeout:15000})` + `txContext.drainCommitHooks(tx)` перед коммитом (unit-of-work.ts:52).
- `IdempotencyInterceptor` — глобальный, opt-in по заголовку 8–200 симв. на POST/PUT/PATCH/DELETE; протокол: INSERT-резерв до хендлера; P2002 → другой requestHash → 409, in-flight → 409 (кроме lease>10мин), протухший → перезахват, иначе кэш `responseBody`; `completedAt` — commit-hook в ALS, дренится ВНУТРИ первой доменной tx (атомарность R6); ошибка хендлера → release.
- `AllExceptionsFilter`: P2002→409, P2025→404, P2003/P2014→400, P2034→409, P2024/P1001/P1002→503, ZodError→400, FastifyError со statusCode 4xx → как есть, прочее → 500.
- Валидация: точечный `ZodPipe` per-параметр, глобального пайпа НЕТ; multipart-пути (attachments, import/preview, warehouse/import/preview) — мимо Zod.
- Лимиты: JSON bodyLimit = Fastify default 1MiB (не задан), multipart 10MB, nginx `client_max_body_size 20M`; CORS не включён (same-origin by design); security headers на nginx (HSTS, nosniff, frame-ancestors telegram.org).
- Незащищённые пути: `GET /health`, `POST /auth/logout`.
- Миграционная дисциплина: CHECK/partial-unique/expression-index существуют ТОЛЬКО в SQL миграций (drift by design; `prisma migrate dev` предлагает их дропнуть — защита: CLAUDE.md «грабли» + CI-guard суффикса `_active_key`); backfill-миграция F0 валит деплой RAISE EXCEPTION при расхождении qty↔лоты.
- `AuditService.record(client|undefined)`: с TxClient — в той же tx, ошибка пробрасывается; без — автономно, ошибка глотается. `GET /workspaces/:wsId/audit` (limit ≤500, cursor).

---

## 2. Стыки блоков

Канал: «вызов» = вызов сервиса в одной UoW-транзакции; «таблица» = связь через общие строки БД; «кэш» = derived-поле, которое читатель считает истиной.

| # | Стык | Канал | Инварианты согласования (обязаны выполняться) |
|---|---|---|---|
| S1 | Orders → Warehouse | вызов: `decrementForSale`/`reverseConsumption`/`restock`/`unitCostAtSaleFor` с общим `tx` | Все вызовы — внутри UoW заказа; лок-порядок Order → WarehouseItem → StockLot(FIFO); мульти-SKU через `sortItemsForLocking`; `OrderItem.unitCostAtSale` (складских) — ТОЛЬКО из net-леджера `netConsumedForOrderItem`; `NoConsumptionsError` → fallback `restock(cost = unitCostAtSale ?? unitCost ?? null)`; reverseFinalization возвращает netOut = out − returnedQty |
| S2 | Orders → Transactions | таблица: Transaction(orderId, kind ∈ {ORDER_PAYMENT, ORDER_REFUND, COGS, VARIABLE_COST}) | После каждой денежной мутации в той же tx `syncPaymentState`: `Order.paidAmount = Σ живых ORDER_PAYMENT − Σ ORDER_REFUND`, `paymentStatus` derived; COGS — только по ручным позициям; сторно COGS через `originalTxId` и только при найденном оригинале; `remove` гасит все проводки заказа; generic API обязан блокировать SYSTEM_KINDS |
| S3 | Orders/Transactions/Purchases → Справочники | вызов-валидация: validateRefs / assertRefs / assertOrderRefs (`findFirst` ws + deletedAt:null) | Ссылки живые на момент проверки; проверка pre-tx БЕЗ лока (in-tx перепроверка есть только у счёта заказа — `assertAccountTx`); Restrict FK на Account/WarehouseItem не даёт физически удалить используемое |
| S4 | Purchases → Warehouse | вызов: `applyPurchaseLine` per-line в той же UoW | Строки отсортированы warehouseItemId ASC (лок-порядок); лот 1:1 со строкой (purchaseLineId), receivedAt = дата закупки (бэкдейт — logger.warn, рекостинга нет); `recomputeCaches` под локом item |
| S5 | Purchases → Transactions | таблица: `Purchase.transactionId @unique` (1:1, Cascade) | amount = Σ `money(qty×unitPrice)`; PURCHASE = единственное признание расхода складской себестоимости; пути реверса нет — компенсация только SUPPLIER_REFUND |
| S6 | Warehouse → Transactions | вызов в своей UoW: WRITE_OFF / SUPPLIER_REFUND | WRITE_OFF неденежный (NON_CASH_KINDS), счёт «технический» первый активный, loss=0 → без проводки; SUPPLIER_REFUND cash-basis (variance с лотовой стоимостью без проводки), movement ref `{refType:'Transaction', refId}`; приоритет лотов этого поставщика |
| S7 | Import → Transactions | таблица: createMany в сыром `prisma.$transaction` | Дедуп двухслойный: fileHash батча → 409, partial-unique (ws, importHash) → откат всего батча; kind = OTHER либо ORDER_PAYMENT; физического undo нет |
| S8 | Import → Orders | вызов: `OrderService.recalcPaymentState(ws, orderId, tx)` в той же tx | Привязывать можно только INCOME-строки; заказы перепроверяются внутри tx (TOCTOU-чек); counterpartyId привязанных = order.clientId (вкл. null); кэш paidAmount обязан сойтись после батча |
| S9 | Import → Справочники | таблица: авто-создание Counterparty (lowercase-имя), чтение CategoryRule | Один accountId на батч (проверен pre-tx); авто-категоризация по keyword/priority |
| S10 | Transfers → Transactions | таблица: 2–3 ноги с `transferGroupId = Transfer.id` | Ноги обязаны жить/умирать вместе (softDelete transfer гасит updateMany по transferGroupId); OUT и IN равны amount, fee отдельной VARIABLE_COST; generic-API эту парность НЕ защищает (§4 N-6) |
| S11 | Transfers → Accounts | вызов: `SELECT…FOR UPDATE` обеих строк ORDER BY id | Счета живые + `isArchived=false`; детерминированный порядок локов — анти-deadlock |
| S12 | Reports → Transactions (+Category/Account) | таблица (read-only SQL/groupBy) | Смысл отчёта = дисциплина kind у писателей; каждый читатель обязан выбрать корректный exclusion-список (`NON_CASH_CONSOLIDATED` vs `NON_CASH_FOR_ACCOUNT` vs только TRANSFER_*); фильтры `deletedAt IS NULL` + `Transaction.date`; бакет = Category.bucket → fallback bucketForSystemKind |
| S13 | Trade-reports → Orders | кэши: `Order.closedAt/paidAmount/totalAmount/paymentStatus`, `OrderItem.unitCostAtSale` | finalize обязан ставить closedAt и снапшоты; syncPaymentState обязан держать кэши истинными — margin/receivables НЕ читают Transaction и не могут скорректировать расхождение |
| S14 | Reconciliation → Transactions/Account/AccountBalanceCheck | таблица (read) + append снимков | computedBalance = openingBalance + Σ по kind notIn NON_CASH_FOR_ACCOUNT; снимки append-only, удаление физическое; discrepancy = actual − computed на endOfDay(даты снимка) UTC+5 |
| S15 | Витрины заказа → Warehouse | кэш: `warehouseItem.avgCost` (estimate-маржа), чтение net-леджера | avgCost валиден лишь как «подсказка» — обязан пересчитываться `recomputeCaches` при каждой лот-операции; estimate-каскад срабатывает только до финализации |
| S16 | Frontend → API | HTTP `/api/v1` (nginx/Next rewrite), JWT cookie | Idempotency-Key на 4 денежных мутациях; наборы инвалидаций обязаны накрывать все derived-витрины затронутых блоков (ORDERS-SET — 11 ключей, CASH-SET, WH-SET, TX-SET); суммы передаются строками |
| S17 | Infra(идемпотентность) → все мутации | глобальный interceptor + ALS + `UnitOfWork.drainCommitHooks` | `completedAt` коммитится атомарно с доменной проводкой ТОЛЬКО на путях через UoW; generic tx CRUD и import — fallback best-effort после ответа |
| S18 | Auth/Workspace → все блоки | guard-цепочка, wsId только из path | Каждый сервисный запрос обязан дублировать `workspaceId` в where (guard проверяет доступ, но не фильтрует данные); роль в контексте есть, но не энфорсится (плоская модель — осознанно) |
| S19 | Audit → домены | вызов `audit.record(tx\|undefined)` | В tx: purchase.register, order.installment/return/finalize/cancel/reopen/delete, warehouse.write-off; post-hoc вне tx: transaction.update/delete; НЕ пишут: transaction.create, transfers, order.addPayment, warehouse.supplier-return, import.commit |

---

## 3. Сквозные инварианты

### 3.1 Workspace-изоляция
- **Закреплена:** `apps/api/src/common/workspace.guard.ts` (wsId ТОЛЬКО из `req.params.wsId`; членство + `workspace.deletedAt` одним prisma-запросом; 403 на не-члена/удалённый ws) + конвенция `where.workspaceId` в каждом запросе каждого сервиса + FK `onDelete: Cascade` от Workspace на все доменные таблицы (кроме `AuditLog.workspaceId → SetNull`) + partial-unique per-workspace + `@@index([workspaceId, deletedAt])` почти везде.
- **Обязаны соблюдать:** все сервисы и репозитории (guard не фильтрует данные); include-цепочки полагаются на инвариант записи (пример: `openLots` включает supplier/account без ws-фильтра — корректно только пока лоты пишутся с ws-чистыми ссылками, инварианты B1/B4).
- **Изъятия:** `IdempotencyKey` — глобальная таблица без workspaceId (изоляция ответа через requestHash, включающий URL с wsId); `AuditLog.workspaceId` nullable; `Attachment` держит workspaceId напрямую, файлы на диске сегментированы per-ws.

### 3.2 deletedAt (soft-delete)
- **Закреплён:** поле на 14 моделях (Workspace, Account, Category, Counterparty, Order, PaymentScheduleEntry, OrderItem, WarehouseItem, Purchase, StockLot, Transaction, Transfer, ImportBatch, CategoryRule); partial-unique индексы `WHERE deletedAt IS NULL`; резолв ссылок и все отчёты фильтруют `deletedAt: null`.
- **Обязаны:** все читатели (списки, отчёты, validateRefs) и все писатели (только soft-delete; физического delete `Transaction` в src нет).
- **Изъятия:** без поля — append-only `StockMovement`, `LotConsumption`, `AccountBalanceCheck`, `AuditLog`; `PurchaseLine`/`Attachment` умирают каскадом; `IdempotencyKey` — TTL. Жёсткое удаление существует: `PaymentScheduleEntry` (replace-all в setSchedule — при живом поле deletedAt, §4 N-4), `AccountBalanceCheck.deleteCheck`, файл вложения (если hash больше не используется).

### 3.3 Decimal и округления
- **Закреплены:** БД `Decimal(14,2)` деньги / `(14,3)` количества / `(14,4)` себестоимость единицы; `apps/api/src/common/money.ts` — `money`=2dp, `cost`=4dp, `qty`=3dp, глобально `ROUND_HALF_UP`; DB CHECK-и знаков (`20260615211446`, `20260628121756`; осознанно без CHECK: Transaction.amount — минус для сторно); DTO передают деньги строками; фронт — `packages/shared/src/money.ts` (decimal.js-light, `parseAmountInput` для форм).
- **Обязаны:** любые вычисления сумм на бэке; фронт-формы.
- **Изъятия (факт):** `Number()` в сортировках/share/сериях графиков (pnl `buildBreakdown`, breakdown `assemble`, margin, receivables, `builders.ts:113`); фронт-страницы warehouse/reports считают производные float'ом (§4 N-19).

### 3.4 Kind-классификация и NON_CASH
- **Закреплены:** `apps/api/src/common/transaction-kinds.ts` — `TRANSFER_LEG_KINDS`, `NON_CASH_KINDS=[COGS, WRITE_OFF]`, `NON_CASH_FOR_ACCOUNT`, `NON_CASH_CONSOLIDATED`; `SYSTEM_KINDS` (`transaction/transaction.service.ts:18`) — барьер generic-API; `MANUAL_KINDS_BY_TYPE` (`transaction.dto.ts:19`) — whitelist создания; `bucketForSystemKind` (pnl.service.ts:283–307) — P&L-семантика системных kind. Соответствие type↔kind — ТОЛЬКО на сервисе, БД не проверяет.
- **Обязаны:** каждый писатель Transaction (корректная пара type+kind, см. таблицу точек записи в разрезе tx-writers — 19 точек); каждый читатель (правильный exclusion-список под свой вопрос: по счёту переводы реальны, консолидированно — гасятся; COGS/WRITE_OFF — в P&L, но не в cashflow).
- **Изъятия:** TRANSFER_* — де-факто системные, но вне SYSTEM_KINDS; VARIABLE_COST двойной природы (ручной + авто-комиссии перевода/рассрочки), в exclusion-списки не входит намеренно.

### 3.5 Идемпотентность
- **Закреплена:** `apps/api/src/common/idempotency.interceptor.ts` (глобален через `app.useGlobalInterceptors`, opt-in по заголовку `Idempotency-Key` 8–200 симв.) + `common/transactional-context.ts` (ALS c commit-hooks) + `UnitOfWork.drainCommitHooks` (unit-of-work.ts:52) + таблица `IdempotencyKey` (PK=key, requestHash=sha256(method\nurl\nstableStringify(body)), TTL 24ч, lease in-flight 10мин).
- **Обязаны:** денежные мутации — идти через UoW (иначе `completedAt` не атомарен с проводкой); фронт — слать ключ (шлёт на 4: purchases, order payments, installment, finalize); Import — собственная защита (fileHash 409 + importHash partial-unique); Orders — app-идемпотентность finalize/cancel через early-return.
- **Изъятия:** generic tx CRUD и import.commit — вне UoW, `completedAt` фиксируется fallback'ом best-effort; большинство мутаций фронт вызывает без ключа (transfers, returns, write-off, adjust, CRUD справочников…).

### 3.6 Аудит
- **Закреплён:** `apps/api/src/audit/audit.service.ts` — `record(client|undefined)`: с TxClient — в той же транзакции (ошибка пробрасывается), без — автономно (ошибка глотается); чтение `GET /workspaces/:wsId/audit`.
- **Фактическое покрытие:** в tx — `purchase.register`, `order.installment`, `order.return`, `order.finalize`, `order.cancel`, `order.reopen`, `order.delete`, `warehouse.write-off`; post-hoc вне tx — `transaction.update`, `transaction.delete`.
- **Дыры (факт, вход аудита):** `transaction.create`, transfer create/delete (сервис вообще без AuditService), `order.addPayment`, `warehouse.supplier-return` (action объявлен в AuditAction, не вызывается), `import.commit`.

### 3.7 UoW и лок-дисциплина (дополнительный сквозной)
- **Закреплены:** `common/unit-of-work.ts` (maxWait 5s, timeout 15s); иерархия локов: `Order` row → `WarehouseItem` row (якорь SKU) → `StockLot` rows в FIFO-порядке; счета — `FOR UPDATE ORDER BY id`; мульти-строчные операции сортируют SKU (`sortItemsForLocking`, сортировка строк закупки).
- **Обязаны:** orders, warehouse, purchases, transfers (все мутации).
- **Вне дисциплины (факт):** `transaction.service` — ни одной tx; `import.service` — сырой `$transaction` без drainCommitHooks.

### 3.8 Derived-кэши (дополнительный сквозной)
| Кэш | Истина | Пересчитыватель (обязан — в той же tx) |
|---|---|---|
| WarehouseItem.qty, avgCost | Σ открытых StockLot | `recomputeCaches` под FOR UPDATE item, после каждой лот-операции |
| StockLot.qtyRemaining | qtyInitial − Σ знаковых LotConsumption | лот-операции под локом item |
| Order.paidAmount, paymentStatus | Σ живых ORDER_PAYMENT/ORDER_REFUND | `syncPaymentState` (orders) / `recalcPaymentState` (import) |
| Order.subtotal, totalAmount | Σ items − discount | order.service при записи строк |
| OrderItem.lineTotal | qty × unitPrice | сервис при записи |
| OrderItem.unitCostAtSale | net-леджер LotConsumption по orderItemId | `unitCostAtSaleFor` (ship/finalize/returnItem); услуги — = unitCost при finalize |
| StockMovement.qtyAfter, LotConsumption.unitCost | снимки на момент записи | append-only, не пересчитываются |

Отчёты и фронт читают кэши как истину; сверки кэш↔истина на чтении нет (кроме гейта в миграции F0-backfill).

---

## 4. Замеченные несоответствия фактов (вход для поиска проблем, не выводы)

### 4.1 Прямые противоречия разрезов (schema-комментарии vs код)

- **N-1. Приоритет себестоимости в марже.** Разрез schema: «OrderItem.unitCost (ручной) имеет приоритет над снапшотом» (комментарий схемы). Разрезы orders-warehouse/reports: каскад в `orders/order-margin.ts` и `trade-reports/margin.service.ts` — `unitCostAtSale` (снапшот) ПРИОРИТЕТНЕЕ `unitCost`. Комментарий схемы и код противоречат.
- **N-2. Момент простановки unitCostAtSale.** Schema-комментарий: «снапшот на момент DONE; null до финализации». Код: `ship` (order.service.ts:452–507) ставит `unitCostAtSale` при статусе OPEN, до finalize.
- **N-3. Семантика сторно.** Schema-комментарий: «сторно через originalTxId (сумма = −original.amount)». Код `returnItem` (order.service.ts:631): частичное сторно COGS `amount = −(returnQty×unitCost)` — при частичном возврате НЕ равно −original.amount.
- **N-4. PaymentScheduleEntry.deletedAt мёртв на записи.** Schema: поле есть (в списке 14 soft-delete моделей); код `setSchedule` — hard `deleteMany + createMany` (replace-all). Читатели (receivables) при этом фильтруют `deletedAt: null`.
- **N-5. «Движения не создают Transaction».** Schema-комментарий к StockMovement; фактически `writeOff`/`supplierReturn` создают Transaction в той же UoW рядом с движением (движение ссылается на проводку через refType/refId). Формулировки расходятся — уточнить смысл комментария при аудите склада.

### 4.2 Инвариант заявлен — механизм не защищает

- **N-6. Ноги перевода удаляемы поодиночке.** TRANSFER_IN/OUT де-факто системные (создаёт только TransferService, в ManualKindEnum их нет), но в SYSTEM_KINDS не входят → generic `DELETE /transactions/:id` может погасить одну ногу, ломая парность transferGroupId, которую `TransferService.softDelete` поддерживает каскадом (tx-writers §2 #3, §3).
- **N-7. VARIABLE_COST двойной природы.** Авто-комиссии (перевод transfer.service:112, рассрочка order.service:361) редактируемы/удаляемы через generic API как «ручные»; при этом удаление перевода гасит комиссию по transferGroupId, а одиночное удаление комиссии — допустимо.
- **N-8. Reconciliation внутренне несогласован.** `computedBalance` исключает COGS/WRITE_OFF (`NON_CASH_FOR_ACCOUNT`), а блок «несведённых» (`opsBetween`, reconciliation.service.ts:169–177) — без kind-фильтра вовсе: `unreconciled.net` включает COGS/WRITE_OFF/переводы.
- **N-9. Cashflow consolidated: opening vs обороты.** Opening = Σ openingBalance только ЖИВЫХ счетов; обороты суммируются без join к живости счёта — транзакции soft-deleted счёта участвуют в потоках, но его openingBalance исключён (cashflow.service.ts:156–169 vs 202–233).
- **N-10. Обращение с удалёнными справочниками неоднородно.** breakdown загружает Category/Counterparty с `deletedAt: null` (удалённый → «—»); margin by-client — Counterparty БЕЗ deletedAt-фильтра (margin.service.ts:83–85); P&L — категория удалена → fallback `bucketForSystemKind`.
- **N-11. Два разных каскада себестоимости.** Витрина заказа: `unitCostAtSale → unitCost → avgCost (estimate) → 0`; trade-reports margin: `unitCostAtSale → unitCost → 0` (без avgCost). Для DONE-заказов складские позиции обычно имеют снапшот, но fallback-ветки различаются.
- **N-12. Границы суток непоследовательны.** reconciliation: asOf → `endOfDay` UTC+5; receivables: asOf — сырой `new Date()` без endOfDay, при том что внутри неё scheduleView сравнивает с `endOfDay(dueDate)` UTC+5; transfer.create: date — сырой `new Date(input.date)`.
- **N-13. Экспорт печатает период в UTC.** Границы считаются в UTC+5, а в шапке CSV/XLSX — `toISOString().slice(0,10)`: «01 июня 00:00 UTC+5» печатается как `05-31` (csv.ts:52, xlsx.ts:20).
- **N-14. Дефолт периода разный.** reports → this-month; margin → вся история (без периода); dashboard summary → допускает односторонний from/to; margin частичный from без to → 400; в resolvePeriod одиночный from игнорируется.
- **N-15. TOCTOU-семейство валидаций ссылок.** validateRefs (transactions), assertRefs (purchases), assertOrderRefs (orders: склад) — pre-tx без лока и без in-tx перепроверки; исключение сделано только для счёта заказа (`assertAccount` pre-tx + `assertAccountTx` в tx — помечено как TOCTOU #9).
- **N-16. Import мимо UoW.** `import.service.ts:412` — сырой `prisma.$transaction` → `drainCommitHooks` не вызывается → идемпотентный `completedAt` не атомарен (fallback после ответа). Сейчас фронт не шлёт ключ на import — латентно.
- **N-17. Аудит post-hoc и дыры.** `transaction.update/delete` — аудит после апдейта, вне tx, ошибка глотается; полный список без аудита — §3.6. TransferService не знает об AuditService вовсе.
- **N-18. IdempotencyKey глобален.** PK=key без workspaceId: коллизия ключей разных workspace'ов даёт 409 (разный requestHash), а не изоляцию по тенанту; таблица общая, чистка только по TTL.

### 4.3 Фронтовые несостыковки

- **N-19. Float на деньгах.** warehouse/page.tsx:44 (`Number(qty)*Number(avgCost)`), :615 (итог диалога закупки reduce на float); reports/page.tsx:231 (`Number(income)−Number(expense)`), серии графиков/проценты в reports/*, categories/page.tsx:85 — при стандарте «деньги = строки + Decimal» (соблюдается в orders/import).
- **N-20. Пробелы инвалидаций.** `useCreatePurchase` не гасит `['warehouse-lots']` (открытая витрина лотов устареет); transactions CRUD не гасит `['accounts']` и `['trade-reports']` (в отличие от orders/purchases/transfers); ORDERS-SET гасит `['accounts', wsId]`, TX-SET — нет.
- **N-21. Client-side 401 — тупик.** Единственная защита — SSR-gate layout'а; в живой сессии протухший JWT → retry 1 → тихий error-state без redirect/toast; `ApiError.status` нигде не читается. 419 не упоминается нигде.
- **N-22. Ошибки мутаций теряются.** Fire-and-forget `finalize.mutate`/`reopen.mutate`/`uploadAtt.mutate` (orders/page.tsx:1197/1187/1047) без catch и без рендера `.error`; `ConfirmDialog` (components/ui/ConfirmDialog.tsx:40) — reject уходит в unhandled, диалог остаётся открыт; `toast.error` не используется нигде.

### 4.4 Конфиг-напряжения и стилистические неоднородности (фон для аудита)

- **N-23. Лимиты тел рассинхронизированы.** JSON bodyLimit = Fastify default 1MiB (нигде не задан) vs multipart 10MB vs nginx 20M — большой `import/commit` (JSON-батч) упрётся в 1MiB раньше остальных лимитов.
- **N-24. Троттлинг только на 3 login-эндпоинтах.** ThrottlerModule подключён, APP_GUARD не зарегистрирован — остальной API не троттлится (включая мутации денег).
- **N-25. API-стиль неоднороден.** DELETE в orders/warehouse → 200 с телом, в остальных модулях → 204; userId доставляется то как `@CurrentUser().sub` (transactions, import), то как `ws.userId` (orders/transfers/warehouse/purchases) — одно значение, два канала; multipart-пути (3 шт.) обходят Zod.
- **N-26. Имя NON_OP живёт дважды.** `CategoryBucket.NON_OP` удалён миграцией (→OTHER), но `TransactionKind.NON_OP` остался ручным EXPENSE-kind — терминологическая коллизия при чтении отчётов.

---

## Приложение: владение таблицами (писатель → таблицы)

| Таблица | Пишут блоки (операции) |
|---|---|
| User | Auth (upsert при входе) |
| Workspace, WorkspaceMember | Auth/Workspace |
| Account, Category, Counterparty, CategoryRule | Справочники; Counterparty также Import (авто-создание) |
| Transaction | Transactions-шина (ручные kind); Orders (ORDER_PAYMENT/ORDER_REFUND/COGS/VARIABLE_COST-fee); Purchases (PURCHASE); Warehouse (WRITE_OFF/SUPPLIER_REFUND); Transfers (TRANSFER_IN/OUT/VARIABLE_COST-fee); Import (OTHER/ORDER_PAYMENT, createMany) |
| Order, OrderItem, PaymentScheduleEntry | Orders; Order.paidAmount/paymentStatus также Import (recalcPaymentState) |
| WarehouseItem, StockLot, StockMovement, LotConsumption | Warehouse (в т.ч. по вызову из Orders/Purchases); MIGRATION-лоты — только миграция F0-backfill |
| Purchase, PurchaseLine | Purchases |
| Transfer | Transfers |
| AccountBalanceCheck | Reconciliation (append-only + физический delete) |
| ImportBatch | Import |
| Attachment | Infra/Attachments (по эндпоинтам Orders/Transactions) |
| AuditLog | Infra/Audit (по вызовам доменов) |
| IdempotencyKey | Infra/IdempotencyInterceptor (+commit-hook в UoW) |

Read-only блоки: Reports, Trade-reports, Витрины заказа, Frontend, Health.
