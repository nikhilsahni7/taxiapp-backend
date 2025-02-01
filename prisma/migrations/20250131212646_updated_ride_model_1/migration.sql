-- AlterTable
ALTER TABLE "Ride" ADD COLUMN     "endOdometer" DOUBLE PRECISION,
ADD COLUMN     "startOdometer" DOUBLE PRECISION,
ALTER COLUMN "rentalPackageKms" SET DATA TYPE DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "RideLocationLog" (
    "id" TEXT NOT NULL,
    "rideId" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "speed" DOUBLE PRECISION,
    "heading" DOUBLE PRECISION,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "odometer" DOUBLE PRECISION,

    CONSTRAINT "RideLocationLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RideLocationLog_rideId_timestamp_idx" ON "RideLocationLog"("rideId", "timestamp");

-- AddForeignKey
ALTER TABLE "RideLocationLog" ADD CONSTRAINT "RideLocationLog_rideId_fkey" FOREIGN KEY ("rideId") REFERENCES "Ride"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
