-- AlterTable
ALTER TABLE "LongDistanceBooking" ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "cancelledBy" "CancelledBy";
