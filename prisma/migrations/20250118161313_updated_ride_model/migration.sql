-- AlterTable
ALTER TABLE "Ride" ADD COLUMN     "cancellationFee" DOUBLE PRECISION,
ADD COLUMN     "cancellationReason" TEXT,
ADD COLUMN     "cancelledBy" "UserType";
