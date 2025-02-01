/*
  Warnings:

  - The `cancelledBy` column on the `Ride` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- CreateEnum
CREATE TYPE "CancelledBy" AS ENUM ('USER', 'DRIVER', 'SYSTEM');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TransactionType" ADD VALUE 'RENTAL_PAYMENT';
ALTER TYPE "TransactionType" ADD VALUE 'RENTAL_CANCELLATION';

-- AlterTable
ALTER TABLE "Ride" ADD COLUMN     "currentLat" DOUBLE PRECISION,
ADD COLUMN     "currentLng" DOUBLE PRECISION,
ADD COLUMN     "driverArrivedAt" TIMESTAMP(3),
ADD COLUMN     "driverAssignedAt" TIMESTAMP(3),
ADD COLUMN     "estimatedEndKms" DOUBLE PRECISION,
ADD COLUMN     "estimatedStartKms" DOUBLE PRECISION,
ADD COLUMN     "lastLocationUpdate" TIMESTAMP(3),
ADD COLUMN     "otpVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "rideEndedAt" TIMESTAMP(3),
ADD COLUMN     "rideStartedAt" TIMESTAMP(3),
DROP COLUMN "cancelledBy",
ADD COLUMN     "cancelledBy" "CancelledBy";
