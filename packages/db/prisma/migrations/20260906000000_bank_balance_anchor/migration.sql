-- Остаток по банку и якорь начального остатка (волна «Правда о деньгах»).
-- Account.openingAnchoredAt — когда openingBalance был выведен из остатка банка
-- (или сверки, принятой как якорь), а не введён руками.
-- IntegrationConnection.bankBalance/bankBalanceAt — остаток счёта по данным
-- банка на момент последнего синка («по банку» в UI).

-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "openingAnchoredAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "IntegrationConnection" ADD COLUMN     "bankBalance" DECIMAL(14,2),
ADD COLUMN     "bankBalanceAt" TIMESTAMP(3);
