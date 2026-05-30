-- Шаг 2/2 упрощения схемы: ДРОП устаревших enum-значений.
-- Все строки уже переназначены предыдущей миграцией (remap), поэтому USING-каст
-- ниже не встретит старых значений.

-- AlterEnum
BEGIN;
CREATE TYPE "AccountType_new" AS ENUM ('CASH', 'BANK', 'OTHER');
ALTER TABLE "Account" ALTER COLUMN "type" TYPE "AccountType_new" USING ("type"::text::"AccountType_new");
ALTER TYPE "AccountType" RENAME TO "AccountType_old";
ALTER TYPE "AccountType_new" RENAME TO "AccountType";
DROP TYPE "AccountType_old";
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "CategoryBucket_new" AS ENUM ('REVENUE', 'COGS', 'FIXED', 'VARIABLE', 'TAX', 'CAPITAL', 'OTHER');
ALTER TABLE "Category" ALTER COLUMN "bucket" DROP DEFAULT;
ALTER TABLE "Category" ALTER COLUMN "bucket" TYPE "CategoryBucket_new" USING ("bucket"::text::"CategoryBucket_new");
ALTER TYPE "CategoryBucket" RENAME TO "CategoryBucket_old";
ALTER TYPE "CategoryBucket_new" RENAME TO "CategoryBucket";
DROP TYPE "CategoryBucket_old";
ALTER TABLE "Category" ALTER COLUMN "bucket" SET DEFAULT 'OTHER';
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "OrderStatus_new" AS ENUM ('OPEN', 'DONE', 'CANCELLED');
ALTER TABLE "Order" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Order" ALTER COLUMN "status" TYPE "OrderStatus_new" USING ("status"::text::"OrderStatus_new");
ALTER TYPE "OrderStatus" RENAME TO "OrderStatus_old";
ALTER TYPE "OrderStatus_new" RENAME TO "OrderStatus";
DROP TYPE "OrderStatus_old";
ALTER TABLE "Order" ALTER COLUMN "status" SET DEFAULT 'OPEN';
COMMIT;

-- AlterTable
ALTER TABLE "Order" ALTER COLUMN "status" SET DEFAULT 'OPEN';
