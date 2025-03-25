-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "VendorBookingStatus" ADD VALUE 'DRIVER_PICKUP_STARTED';
ALTER TYPE "VendorBookingStatus" ADD VALUE 'DRIVER_ARRIVED';

-- AlterTable
ALTER TABLE "vendor_bookings" ADD COLUMN     "driverArrivedAt" TIMESTAMP(3),
ADD COLUMN     "otp" TEXT;
