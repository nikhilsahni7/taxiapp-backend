-- AlterEnum
ALTER TYPE "RideType" ADD VALUE 'CAR_RENTAL';

-- AlterTable
ALTER TABLE "Ride" ADD COLUMN     "actualKmsTravelled" DOUBLE PRECISION,
ADD COLUMN     "actualMinutes" INTEGER,
ADD COLUMN     "extraKmCharges" DOUBLE PRECISION,
ADD COLUMN     "extraMinuteCharges" DOUBLE PRECISION,
ADD COLUMN     "isCarRental" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "rentalBasePrice" DOUBLE PRECISION,
ADD COLUMN     "rentalPackageHours" INTEGER,
ADD COLUMN     "rentalPackageKms" INTEGER;
