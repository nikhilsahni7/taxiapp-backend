-- AlterEnum
ALTER TYPE "VendorBookingTransactionType" ADD VALUE 'APP_COMMISSION';

-- AlterTable
ALTER TABLE "vendor_bookings" ADD COLUMN     "tripType" "OutstationTripType";
