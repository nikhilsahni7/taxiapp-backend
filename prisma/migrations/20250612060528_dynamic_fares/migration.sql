-- CreateEnum
CREATE TYPE "ServiceType" AS ENUM ('LOCAL', 'CAR_RENTAL', 'OUTSTATION', 'HILL_STATION', 'ALL_INDIA_TOUR', 'CHARDHAM_YATRA');

-- CreateEnum
CREATE TYPE "RateType" AS ENUM ('PER_KM_SHORT', 'PER_KM_LONG', 'PER_DAY', 'BASE_RATE', 'SHORT_RATE', 'PACKAGE_PRICE', 'PACKAGE_KM', 'EXTRA_KM', 'FIXED_RATE');

-- AlterTable
ALTER TABLE "DriverDetails" ADD COLUMN     "hasInsufficientBalance" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "fcmToken" TEXT;

-- CreateTable
CREATE TABLE "FareConfiguration" (
    "id" TEXT NOT NULL,
    "serviceType" "ServiceType" NOT NULL,
    "vehicleCategory" TEXT NOT NULL,
    "rateType" "RateType" NOT NULL,
    "packageHours" INTEGER,
    "amount" DOUBLE PRECISION NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastEditedBy" TEXT,
    "lastEditedAt" TIMESTAMP(3),

    CONSTRAINT "FareConfiguration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceEditLog" (
    "id" TEXT NOT NULL,
    "serviceType" "ServiceType" NOT NULL,
    "editedBy" TEXT NOT NULL,
    "editedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changesCount" INTEGER NOT NULL,
    "editSummary" JSONB,

    CONSTRAINT "ServiceEditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FareConfiguration_serviceType_vehicleCategory_rateType_isAc_idx" ON "FareConfiguration"("serviceType", "vehicleCategory", "rateType", "isActive");

-- CreateIndex
CREATE INDEX "FareConfiguration_serviceType_lastEditedAt_idx" ON "FareConfiguration"("serviceType", "lastEditedAt");

-- CreateIndex
CREATE UNIQUE INDEX "FareConfiguration_serviceType_vehicleCategory_rateType_pack_key" ON "FareConfiguration"("serviceType", "vehicleCategory", "rateType", "packageHours");

-- CreateIndex
CREATE INDEX "ServiceEditLog_serviceType_editedAt_idx" ON "ServiceEditLog"("serviceType", "editedAt");
