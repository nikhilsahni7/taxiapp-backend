-- AlterTable
ALTER TABLE "DriverDetails" ADD COLUMN     "hasCarrier" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Ride" ADD COLUMN     "carrierCharge" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "carrierRequested" BOOLEAN NOT NULL DEFAULT false;
