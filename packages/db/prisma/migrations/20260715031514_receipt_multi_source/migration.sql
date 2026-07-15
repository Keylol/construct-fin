-- CreateEnum
CREATE TYPE "WbReceiptSource" AS ENUM ('WB_CARD', 'DNS', 'ONLINE_TRADE', 'MANUAL');

-- AlterTable
ALTER TABLE "WbReceipt" ADD COLUMN     "source" "WbReceiptSource" NOT NULL DEFAULT 'WB_CARD',
ALTER COLUMN "fpd" DROP NOT NULL;
