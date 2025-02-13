/*
  Warnings:

  - The values [DRIVER_ACCEPTED] on the enum `VendorBookingStatus` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "VendorBookingStatus_new" AS ENUM ('PENDING', 'COMMISSION_PENDING', 'COMMISSION_PAID', 'STARTED', 'COMPLETED', 'CANCELLED');
ALTER TABLE "vendor_bookings" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "vendor_bookings" ALTER COLUMN "status" TYPE "VendorBookingStatus_new" USING ("status"::text::"VendorBookingStatus_new");
ALTER TYPE "VendorBookingStatus" RENAME TO "VendorBookingStatus_old";
ALTER TYPE "VendorBookingStatus_new" RENAME TO "VendorBookingStatus";
DROP TYPE "VendorBookingStatus_old";
ALTER TABLE "vendor_bookings" ALTER COLUMN "status" SET DEFAULT 'PENDING';
COMMIT;

-- AlterTable
ALTER TABLE "vendor_bookings" ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "cancelledBy" TEXT;
