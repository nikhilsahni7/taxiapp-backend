/*
  Warnings:

  - You are about to drop the column `carInteriorUrl` on the `DriverDetails` table. All the data in the column will be lost.
  - You are about to drop the column `carLeftUrl` on the `DriverDetails` table. All the data in the column will be lost.
  - You are about to drop the column `carRightUrl` on the `DriverDetails` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "DriverDetails" DROP COLUMN "carInteriorUrl",
DROP COLUMN "carLeftUrl",
DROP COLUMN "carRightUrl",
ADD COLUMN     "fitnessUrl" TEXT,
ADD COLUMN     "insuranceUrl" TEXT,
ADD COLUMN     "pollutionUrl" TEXT,
ADD COLUMN     "rcUrl" TEXT;
