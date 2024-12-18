/*
  Warnings:

  - You are about to drop the column `location` on the `DriverStatus` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "DriverStatus" DROP COLUMN "location",
ADD COLUMN     "socketId" TEXT;
