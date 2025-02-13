/*
  Warnings:

  - The values [CANCELLED] on the enum `VendorBookingTransactionType` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
ALTER TYPE "VendorBookingStatus" ADD VALUE 'CANCELLED';

-- AlterEnum
BEGIN;
CREATE TYPE "VendorBookingTransactionType_new" AS ENUM ('DRIVER_COMMISSION', 'VENDOR_PAYOUT', 'APP_COMMISSION', 'DRIVER_PAYOUT');
ALTER TABLE "vendor_booking_transactions" ALTER COLUMN "type" TYPE "VendorBookingTransactionType_new" USING ("type"::text::"VendorBookingTransactionType_new");
ALTER TYPE "VendorBookingTransactionType" RENAME TO "VendorBookingTransactionType_old";
ALTER TYPE "VendorBookingTransactionType_new" RENAME TO "VendorBookingTransactionType";
DROP TYPE "VendorBookingTransactionType_old";
COMMIT;
