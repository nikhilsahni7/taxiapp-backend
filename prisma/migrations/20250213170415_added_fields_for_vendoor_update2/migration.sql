-- AlterTable
ALTER TABLE "vendor_bookings" ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "cancelledBy" "CancelledBy";
