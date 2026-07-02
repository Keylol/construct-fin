-- F4 (решение #10): списание со склада — неденежный убыток в P&L.
-- Проводка kind=WRITE_OFF (EXPENSE) создаётся warehouse.writeOff на FIFO-стоимость
-- списанного; кассу не двигает (NON_CASH_KINDS), в P&L падает в бакет COGS.
ALTER TYPE "TransactionKind" ADD VALUE 'WRITE_OFF';
