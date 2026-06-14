# Техкарта: кнопка → сущность → что меняет в БД

> Инструкция для разработчика-владельца: что делает каждая операция, какой метод сервиса её выполняет и что именно меняется в базе. Дополняется по мере появления экранов. Бизнес-описание тех же возможностей — в [capabilities.md](./capabilities.md).

## Принцип: где можно править, где нельзя

Все данные делятся на 3 типа — это определяет, можно ли менять их «как поле» или только действием:

| Тип | Что это | Как менять | Примеры |
|---|---|---|---|
| **1. Справочные поля** | Описывают сущность, ни от чего не зависят | Свободно, формой редактирования | name, sku, unit, note, reorderPoint, defaultSupplier, isArchived; имя/ИНН/роль контрагента; название/группа категории |
| **2. Числа учёта (ledger)** | Система держит их в согласии друг с другом | ТОЛЬКО через операцию (не правится напрямую) | `WarehouseItem.qty`/`avgCost`, `Order.totalAmount`/`paidAmount`/`paymentStatus`, `OrderItem.unitCostAtSale`/`shippedQty`/`returnedQty`, журнал `StockMovement` |
| **3. Системные операции** | Транзакции, созданные родительской операцией | Не трогать саму операцию — править её источник | `Transaction(kind=PURCHASE/COGS/ORDER_PAYMENT/ORDER_REFUND/TRANSFER_*)` |

**Атомарность:** операции типа 2/3 выполняются в одной транзакции БД (UnitOfWork) — меняют всё разом и согласованно (например, `qty` + `avgCost` + запись в `StockMovement`). Поэтому числа учёта нельзя править по отдельности — рассинхрон сломает инварианты. Хочешь изменить — вызывай операцию, а не правь поле.

---

## Склад (`WarehouseItem`)

Таблица: `WarehouseItem` (поля: qty, avgCost, sku, name, unit, reorderPoint, note, defaultSupplierId, isArchived). Журнал: `StockMovement` (append-only).

| Действие (кнопка) | HTTP | Метод сервиса | Что меняет в БД | Атомарно | Деньги |
|---|---|---|---|---|---|
| Создать позицию | `POST /warehouse` | `WarehouseService.create` | `WarehouseItem` (+ при openingQty/Cost: qty, avgCost, `StockMovement(OPENING)`) | да | нет (начальный остаток) |
| Редактировать карточку | `PATCH /warehouse/:id` | `update` | name/sku/unit/note/defaultSupplier/isArchived (**тип 1**; qty/avgCost НЕ трогает) | — | нет |
| **Задать себестоимость остатка** ⭐ новое | `POST /warehouse/:id/set-cost` | `setCost` | `avgCost` (только если был 0) + `StockMovement(ADJUSTMENT, qtyDelta=0)` | да | **нет** (корректировка оценки, не закупка) |
| Инвентаризация (корректировка остатка) | `POST /warehouse/:id/adjust` | `adjust` | `qty` (avgCost НЕ трогает) + `StockMovement(ADJUSTMENT)` | да | нет |
| Возврат поставщику | `POST /warehouse/:id/supplier-return` | `supplierReturn` | `qty`↓, `avgCost` пересчёт + `StockMovement(RETURN_SUPPLIER)` + `Transaction(INCOME, kind=OTHER)` | да | **да** (приход на счёт) |
| Импорт из Excel | `POST /warehouse/import/commit` | `importCommit` | новые `WarehouseItem` + `StockMovement(OPENING)`; дедуп по имени | да | нет |
| Журнал движений | `GET /warehouse/:id/movements` | `listMovements` | — (чтение) | — | — |
| Закупка (приход) | `POST /purchases` | `PurchaseService.register` | `qty`↑, `avgCost` пересчёт (WAVG) + `StockMovement(PURCHASE)` + `Transaction(EXPENSE, kind=PURCHASE)` | да | **да** (списание со счёта) |
| Списание при продаже | (внутри finalize/ship заказа) | `decrementForSale` | `qty`↓ + `StockMovement(SALE)`, снапшот себестоимости в `OrderItem.unitCostAtSale` | да | нет (себестоимость уже признана при закупке) |

**Себестоимость (`avgCost`) — число учёта (тип 2):** меняют только `create`(opening) / `setCost` / закупка / возврат поставщика. Напрямую в форме редактирования её НЕТ — намеренно.

> ⭐ `setCost` ограничен позициями с `avgCost=0` (ещё не оценёнными) **и остатком > 0** (есть что оценивать). Переоценка уже оценённого остатка запрещена — она исказила бы средневзвешенную относительно реальных закупок; это была бы отдельная, более рискованная операция. Влияет только на БУДУЩИЕ продажи; уже проданное по 0 не переписывается.

---

_Далее по мере работы добавим домены: Заказы, Операции/Импорт, Переводы, Сверка, Отчёты — по той же схеме «кнопка → метод → что меняет в БД»._
