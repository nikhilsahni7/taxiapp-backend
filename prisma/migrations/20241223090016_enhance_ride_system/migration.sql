-- AlterTable
ALTER TABLE "DriverStatus" ADD COLUMN     "heading" DOUBLE PRECISION,
ADD COLUMN     "lastLocationUpdate" TIMESTAMP(3),
ADD COLUMN     "speed" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "Ride" ADD COLUMN     "extraCharges" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "waitStartTime" TIMESTAMP(3);
