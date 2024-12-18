-- CreateEnum
CREATE TYPE "RideStatus" AS ENUM ('SEARCHING', 'ACCEPTED', 'DRIVER_ARRIVED', 'RIDE_STARTED', 'RIDE_ENDED');

-- AlterTable
ALTER TABLE "DriverDetails" ADD COLUMN     "carCategory" TEXT;

-- CreateTable
CREATE TABLE "Ride" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "driverId" TEXT,
    "status" "RideStatus" NOT NULL,
    "pickupLocation" TEXT NOT NULL,
    "dropLocation" TEXT NOT NULL,
    "fare" DOUBLE PRECISION,
    "distance" DOUBLE PRECISION,
    "duration" INTEGER,
    "tax" DOUBLE PRECISION,
    "carCategory" TEXT,
    "otp" TEXT,
    "totalAmount" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DriverStatus" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "location" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DriverStatus_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DriverStatus_driverId_key" ON "DriverStatus"("driverId");

-- AddForeignKey
ALTER TABLE "Ride" ADD CONSTRAINT "Ride_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ride" ADD CONSTRAINT "Ride_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverStatus" ADD CONSTRAINT "DriverStatus_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
