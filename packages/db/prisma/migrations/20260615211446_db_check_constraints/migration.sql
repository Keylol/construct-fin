-- F3 (Трек F): инварианты неотрицательности/соотношений на уровне БД.
-- CHECK выражают то, что и так гарантирует сервис, но защищают от прямого
-- SQL/бага в UoW тихо разрушить склад/заказ. Строго аддитивно. Transaction.amount
-- НЕ трогаем (moneyString осознанно допускает минус для сторно-ног). Данные
-- нового прода соответствуют инвариантам; при нарушении деплой упадёт громко на
-- снапшоте (Фаза 0).

-- OrderItem: количества неотрицательны и согласованы с проданным qty.
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_qty_positive" CHECK ("qty" > 0);
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_unitPrice_nonneg" CHECK ("unitPrice" >= 0);
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_shippedQty_nonneg" CHECK ("shippedQty" >= 0);
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_returnedQty_nonneg" CHECK ("returnedQty" >= 0);
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_shippedQty_lte_qty" CHECK ("shippedQty" <= "qty");
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_returnedQty_lte_qty" CHECK ("returnedQty" <= "qty");

-- WarehouseItem: остаток и себестоимость не уходят в минус.
ALTER TABLE "WarehouseItem" ADD CONSTRAINT "WarehouseItem_qty_nonneg" CHECK ("qty" >= 0);
ALTER TABLE "WarehouseItem" ADD CONSTRAINT "WarehouseItem_avgCost_nonneg" CHECK ("avgCost" >= 0);

-- PurchaseLine: положительное количество, неотрицательная цена.
ALTER TABLE "PurchaseLine" ADD CONSTRAINT "PurchaseLine_qty_positive" CHECK ("qty" > 0);
ALTER TABLE "PurchaseLine" ADD CONSTRAINT "PurchaseLine_unitPrice_nonneg" CHECK ("unitPrice" >= 0);

-- Transfer: сумма перевода положительна, комиссия неотрицательна.
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_fee_nonneg" CHECK ("fee" >= 0);
