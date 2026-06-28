# F0 — Переход склада WAVG → FIFO-партии (синтезированный дизайн)

> Источник: design-workflow `wf_d2994d83-019` (4 независимых варианта → 8 адверсариальных
> верификаций, 22 High-нарушения → синтез). Ветка `f0/fifo` от `v6@034232b`.
> Статус: **на утверждении**, реализация не начата.

## Каркас-победитель

`concurrency-migration` (D4): строка `WarehouseItem` под `repo.lockForUpdate` (`SELECT … FOR UPDATE`)
остаётся **единственным якорем сериализации** на SKU; `StockLot`/`LotConsumption` — подчинённые
сущности, мутируемые только под этим локом; `WarehouseItem.qty/avgCost` — **derived-кэши**,
пересчитываемые в той же UoW. Минимальный blast-radius (не трогаем lock-механику, lowStock, list, FE).

**Привито из других вариантов:**
1. (D1) **Адресный реверс** конкретных `LotConsumption` — канонический путь возврата клиента/отката:
   восстанавливаем именно те партии, из которых ушёл товар, по их **снимочной** себестоимости.
2. (D2) **Синтетический RETURN_CUSTOMER-лот** по `unitCostAtSale` — строго как **ограниченный fallback**:
   только для до-миграционных заказов (нет `LotConsumption`) и возвратов на soft-deleted позицию.
3. (D3) Правило: **реверс берёт `unitCost` из снимка `LotConsumption`, никогда из текущего `lot.unitCost`**
   → возврат cost-neutral, снимается конфликт setCost vs неизменяемость партии.

**Ключевые свойства:**
- **M1 умирает структурно** — supplier-return / adjust-вниз / write-off списывают конкретные лоты по их цене.
- `unitCostAtSale` = **чистая деривация** из net-леджера `LotConsumption` по `orderItemId` — одна формула,
  убирает дрейф `weightedCost`, **гарантирует `margin == FIFO-COGS`** (вкл. частичный RMA).
- `stockValue` авторитетно из лотов `Σ(qtyRemaining×unitCost)`; `avgCost`-кэш — только подсказка lowStock/UI.
- **Нет feature-flag dual-path**: деплой single-instance (контейнер заменяется целиком) → нет cutover-race.
- Порядок item-локов `warehouseItemId ASC` **обязателен** во всех мультипозиционных путях; FIFO-ключ
  `(receivedAt ASC, seq ASC)`, `seq = autoincrement`.
- `writeOff`/#10 (P&L) и `PaymentSchedule` вынесены в F4/F2 — F0 даёт только consume-примитив.

## Схема (Prisma)

```prisma
enum StockLotSource { PURCHASE OPENING MIGRATION ADJUSTMENT RETURN_CUSTOMER }
enum LotConsumptionKind { CONSUME REVERSAL }

model StockLot {
  id              String   @id @default(cuid())
  workspaceId     String
  warehouseItemId String
  qtyInitial      Decimal  @db.Decimal(14, 3)   // неизменно после создания
  qtyRemaining    Decimal  @db.Decimal(14, 3)   // = qtyInitial − Σ signed LotConsumption.qty; цель FOR UPDATE
  unitCost        Decimal  @db.Decimal(14, 4)   // >= 0 (CHECK)
  sourceType      StockLotSource
  sourceId        String?                       // слабая ссылка (Purchase.id / Order.id / Adjust), без FK
  purchaseLineId  String?                       // сильная трасса к строке закупки (F5)
  supplierId      String?                       // трасса до поставщика (F5)
  accountId       String?                       // трасса до счёта оплаты закупки (F5)
  receivedAt      DateTime                      // ПЕРВИЧНЫЙ ключ FIFO-сортировки
  seq             BigInt   @default(autoincrement())  // детерминированный tie-break
  createdAt       DateTime @default(now())
  createdById     String
  deletedAt       DateTime?
  // связи: workspace, warehouseItem, purchaseLine?(SetNull), supplier?, account?, createdBy, consumptions[]
  @@index([workspaceId, warehouseItemId, receivedAt, seq])
  @@index([purchaseLineId])
  @@index([workspaceId, supplierId])
}

model LotConsumption {
  id           String   @id @default(cuid())
  workspaceId  String
  lotId        String
  movementId   String                          // всегда задано (каждая лот-операция пишет движение)
  orderItemId  String?                         // ключ адресного реверса и пер-строчной трассы
  qty          Decimal  @db.Decimal(14, 3)     // + списание (CONSUME), − восстановление (REVERSAL); CHECK <> 0
  unitCost     Decimal  @db.Decimal(14, 4)     // СНИМОК lot.unitCost; реверс берёт цену отсюда
  kind         LotConsumptionKind @default(CONSUME)
  reversalOfId String?                         // для REVERSAL → реверсируемая CONSUME-строка
  createdAt    DateTime @default(now())
  // связи: workspace, lot, movement, reversalOf?(self), reversals[]
  @@index([lotId]) @@index([orderItemId]) @@index([movementId]) @@index([reversalOfId])
}
```

Существующие модели: `WarehouseItem.qty/avgCost` → переклассифицировать в derived-кэш (поля **не удалять**),
+ обратные связи (`lots`, `lotConsumptions`, `stockLotsSupplied`, `stockLots`, `createdStockLots`).
CHECK-констрейнты (сырым SQL): `StockLot(qtyInitial>0, qtyRemaining>=0, qtyRemaining<=qtyInitial, unitCost>=0)`,
`LotConsumption(unitCost>=0, qty<>0)`.

## API сервиса (warehouse)

Каждый мутатор: **сначала** `repo.lockForUpdate(tx, ws, itemId)` (якорь), затем `SELECT` открытых лотов
`FOR UPDATE … ORDER BY receivedAt ASC, seq ASC`. Чистая FIFO-математика → `common/fifo.ts`
(`consumePlan`/`reversePlan`) для unit-тестов. Round(14,4) только на финальном снимке.

- **applyPurchaseLine** → `createLot{PURCHASE, purchaseLineId, supplierId, accountId, receivedAt}` + PURCHASE-движение + recomputeCaches.
- **decrementForSale** (расширена `ref={…, orderItemId}`) → consumePlan FIFO; `InsufficientStockError`→400 при нехватке; одно SALE-движение + `LotConsumption{CONSUME}` на каждый лот; возвращает `{qtyConsumed, totalCost}`.
- **reverseConsumption(orderItemId, qty)** (НОВЫЙ) → `consumptionsForOrderItem` (LIFO), восстанавливает `qtyRemaining`; одно RETURN_CUSTOMER-движение + `LotConsumption{REVERSAL, unitCost=снимок, reversalOfId}`; нет потреблений → `NoConsumptionsError` (order.service → fallback restock).
- **restock** (FALLBACK) → `createLot{RETURN_CUSTOMER, unitCost = unitCost ?? item.avgCost}`; soft-deleted item → компенсирующее движение без лота.
- **supplierReturn** → consumePlan с **приоритетом лотов поставщика → spill** на остальные FIFO (гард `returnQty<=item.qty`, не блокируем при достаточном итоге); RETURN_SUPPLIER-движение (`unitCost=Σtake×cost/qty`); `Transaction(INCOME, SUPPLIER_REFUND)` как сейчас.
- **adjust** delta<0 → consumePlan; delta>0 → `createLot{ADJUSTMENT}` (нет лотов и нет `unitCost` → 400).
- **setCost** → `UPDATE StockLot SET unitCost WHERE qtyRemaining>0 AND unitCost=0`.
- **create(openingQty)/importCommit** → обернуть в UoW: item + OPENING-лот + OPENING-движение атомарно.
- **stockValue** → `SUM(qtyRemaining×unitCost)` по открытым лотам (контракт строки не меняется).
- **recomputeCaches** → `qty=Σ qtyRemaining`, `avgCost=Σ(qtyRem×unitCost)/ΣqtyRem` (0 при пустом).
- **lockItems(ids[])** (НОВЫЙ) — сортирует по возрастанию, лочит по очереди (анти-deadlock).

## Изменения order.service (явно меняется)

1. `ship`/`finalize` передают `orderItemId` в `decrementForSale`.
2. **`unitCostAtSale = recompute(orderItemId)`** после каждой лот-операции: `{qty,cost}=netConsumedForOrderItem`; `qty>0 ? round(cost/qty,4) : null`. `weightedCost()` для склада удаляется. `margin.service` не трогаем.
3. `finalize`/`reverseFinalization`/`remove` сортируют `items` по `warehouseItemId ASC`.
4. `returnItem` → `reverseConsumption(returnQty)`; `NoConsumptionsError` → fallback `restock`.
5. `reverseFinalization` → `reverseConsumption(netOut)` (net по остаточной реверсируемости, не двойной реверс RMA).
6. `purchase.service.register` сортирует строки по `warehouseItemId ASC`, пробрасывает `lotMeta{supplierId, accountId, date}`.

## План миграции

Аддитивная, single-instance деплой, короткий write-freeze на backfill.
0. Схема (поля не удалять). 1. `migrate dev --create-only --name f0_fifo_lots` → **вырезать все `DROP INDEX "…_active_key"` (6 шт)** (грабли CLAUDE.md). 2. Сырой SQL: partial FIFO-индекс `WHERE qtyRemaining>0 AND deletedAt IS NULL` + CHECK-констрейнты (зарегистрировать индекс как known-drift). 3. **Backfill — отдельный идемпотентный TS-скрипт** (не в Prisma-миграции): на каждый `WarehouseItem` с `qty>0` (вкл. archived/soft-deleted) ровно один `StockLot{MIGRATION, unitCost=avgCost, receivedAt=createdAt}`; без backfill `LotConsumption`. 4. **Gate сверки**: per-item `qty==ΣqtyRemaining` и `qty×avgCost==Σ(qtyRem×unitCost)`, workspace `stockValue` до==после; расхождение → rollback. 5. Деплой кода. 6. **Пост-деплой verify фактом БД** (не «зелёным» деплоем): `migrate status`, `\d StockLot`, `pg_indexes` (6 `_active_key` + FIFO-индекс), `checkLotInvariants` read-only.

**Обратимость честно:** Prisma не имеет down; кэш `avgCost/qty` держит WAVG-откат численно валидным, но drop таблиц лотов = безвозвратная потеря лот-истории (откат односторонний после первой FIFO-записи).

## Инварианты (проверяются реализацией)

- **I2** `qty == Σ open qtyRemaining` (eps 0.0005).
- **I3** `qtyRemaining == qtyInitial − Σ signed consumption`; `0 ≤ qtyRemaining ≤ qtyInitial`.
- **I5** `stockValue == Σ open(qtyRemaining×unitCost)`; avgCost-кэш сходится с **qty-пропорциональным** eps.
- **I6** для расходного движения с потреблениями `Σ CONSUME == |qtyDelta|`; для адресного реверса `Σ|REVERSAL| == qtyDelta`.
- **I7** per consumption `Σ REVERSAL ≤ consumption.qty` (нет over-reverse).
- **I8** `round(unitCostAtSale×netQty,2) == round(Σ net consumption(qty×unitCost),2)` → `margin == FIFO-COGS`.
- **I9** `Σ open qtyRemaining == 0 ⇒ avgCost == 0` (нет деления на ноль).
- **I12** `REVERSAL.unitCost == unitCost реверсируемой CONSUME` (cost-neutral).
- **I13** для складских товаров COGS-проводки не создаются (cash-basis R1/R2).
- **I10/I11** инфра/миграция: все 6 `_active_key` индексов на месте + FIFO-индекс; сверка остатков до/после.

## План тестов

- **unit** `common/fifo.ts` (consumePlan/reversePlan, дробные qty, точный Decimal); recompute unitCostAtSale.
- **integration warehouse** (новый `warehouse-fifo.integration`): purchase→лот, sale FIFO через несколько лотов, supplier-return приоритет+spill (M1), adjust ±, setCost, create(openingQty) атомарно, stockValue из лотов.
- **integration orders** (расширить money-flows/returns/shipping): частичный ship через 2+ лота; **A=5@100,B=5@200, продажа 10, возврат 5 → margin по оставшимся корректна**; reopen→refinalize детерминизм; cancel после частичного RMA без двойного реверса; до-миграционный заказ через fallback.
- **loadtest**: расширить `checkLotInvariants` (I2–I9); новый сценарий зеркальных SKU {X,Y}/{Y,X} (deadlock-регресс); 5×1000, zero violations.
- **migration-тест**: сид WAVG → backfill → сверка до/после → reopen/return до-миграционного через fallback.

## Отложено (вне F0)

F1 (маржа на бэке + D4), F2 (PaymentSchedule), F4 (writeOff #10 — требует решения по double-count), F5 (витрина трассировки), F3 (рассрочка gross), F-light (color/description), семантика отмены закупки в FIFO, архивация нулевых лотов, backfill LotConsumption для старых заказов.

## Открытые вопросы (бизнес/учёт) — см. блиц к Александру
1. Supplier-return при нехватке лотов поставщика, но достаточном итоге: приоритет+spill (реком.) vs строгий блок.
2. Variance refund vs лотовая стоимость: оставить как INCOME/SUPPLIER_REFUND без отдельной проводки (реком.).
3. Себестоимость излишка инвентаризации (adjust+): требовать unitCost когда нет лотов (реком.) vs avgCost/0.
4. Порядок реверса возврата клиента: LIFO потребления (реком. дефолт).
5. Write-off #10 (блокирует F4, не F0): memo-строка vs истинный неденежный kind.
6. Бэкдейт закупки: разрешить с предупреждением (реком.) vs запретить раньше последней продажи.
7. Историческая supplier/account-трасса до-миграционного остатка теряется (единый MIGRATION-лот): принять (реком.) vs реконструировать.
8. Write-freeze на backfill + подтвердить single-instance деплой.
