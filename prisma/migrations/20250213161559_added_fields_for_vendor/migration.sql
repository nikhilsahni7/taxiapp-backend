/*
  Warnings:

  - The values [COMMISSION_PENDING,COMMISSION_PAID,CANCELLED] on the enum `VendorBookingStatus` will be removed. If these variants are still used in the database, this will fail.
  - You are about to drop the column `cancelReason` on the `vendor_bookings` table. All the data in the column will be lost.
  - You are about to drop the column `cancelledAt` on the `vendor_bookings` table. All the data in the column will be lost.
  - You are about to drop the column `cancelledBy` on the `vendor_bookings` table. All the data in the column will be lost.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "VendorBookingStatus_new" AS ENUM ('PENDING', 'DRIVER_ACCEPTED', 'STARTED', 'COMPLETED');
ALTER TABLE "vendor_bookings" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "vendor_bookings" ALTER COLUMN "status" TYPE "VendorBookingStatus_new" USING ("status"::text::"VendorBookingStatus_new");
ALTER TYPE "VendorBookingStatus" RENAME TO "VendorBookingStatus_old";
ALTER TYPE "VendorBookingStatus_new" RENAME TO "VendorBookingStatus";
DROP TYPE "VendorBookingStatus_old";
ALTER TABLE "vendor_bookings" ALTER COLUMN "status" SET DEFAULT 'PENDING';
COMMIT;

-- AlterEnum
ALTER TYPE "VendorBookingTransactionType" ADD VALUE 'CANCELLED';

-- AlterTable
ALTER TABLE "vendor_bookings" DROP COLUMN "cancelReason",
DROP COLUMN "cancelledAt",
DROP COLUMN "cancelledBy";
