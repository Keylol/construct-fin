-- CreateEnum
CREATE TYPE "WarehouseSection" AS ENUM ('CASE', 'MOTHERBOARD', 'PSU', 'GPU', 'RAM', 'CPU', 'COOLING', 'STORAGE', 'FANS', 'OTHER');

-- AlterTable
ALTER TABLE "WarehouseItem" ADD COLUMN "section" "WarehouseSection";
