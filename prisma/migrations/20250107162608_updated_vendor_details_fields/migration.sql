/*
  Warnings:

  - Added the required column `updatedAt` to the `VendorDetails` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "VendorDetails" ADD COLUMN     "address" TEXT,
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "experience" TEXT,
ADD COLUMN     "gstNumber" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;
