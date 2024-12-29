-- CreateEnum
CREATE TYPE "RideType" AS ENUM ('LOCAL', 'OUTSTATION');

-- CreateEnum
CREATE TYPE "OutstationTripType" AS ENUM ('ONE_WAY', 'ROUND_TRIP');

-- AlterTable
ALTER TABLE "Ride" ADD COLUMN     "driverAcceptedAt" TIMESTAMP(3),
ADD COLUMN     "isDriverAccepted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "outstationType" "OutstationTripType",
ADD COLUMN     "rideType" "RideType" NOT NULL DEFAULT 'LOCAL';
