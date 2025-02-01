-- AlterEnum
ALTER TYPE "TransactionType" ADD VALUE 'DRIVER_REGISTRATION_FEE';

-- AlterTable
ALTER TABLE "DriverDetails" ADD COLUMN     "registrationFeePaid" BOOLEAN NOT NULL DEFAULT false;
