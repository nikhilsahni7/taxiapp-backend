-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TransactionType" ADD VALUE 'DRIVER_CANCELLATION_FEE';
ALTER TYPE "TransactionType" ADD VALUE 'USER_CANCELLATION_FEE_APPLIED';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "outstandingCancellationFee" DOUBLE PRECISION NOT NULL DEFAULT 0;
