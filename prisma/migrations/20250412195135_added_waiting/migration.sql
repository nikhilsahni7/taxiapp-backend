-- AlterTable
ALTER TABLE "Ride" ADD COLUMN     "waitingCharges" DOUBLE PRECISION,
ADD COLUMN     "waitingMinutes" INTEGER,
ADD COLUMN     "waitingStartTime" TIMESTAMP(3);
