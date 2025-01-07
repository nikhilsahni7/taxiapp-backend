-- CreateEnum
CREATE TYPE "VendorBookingStatus" AS ENUM ('PENDING', 'DRIVER_ACCEPTED', 'STARTED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "VendorBookingTransactionType" AS ENUM ('DRIVER_COMMISSION', 'VENDOR_PAYOUT');

-- CreateTable
CREATE TABLE "vendor_bookings" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "driverId" TEXT,
    "serviceType" "LongDistanceServiceType" NOT NULL,
    "pickupLocation" TEXT NOT NULL,
    "pickupLat" DOUBLE PRECISION,
    "pickupLng" DOUBLE PRECISION,
    "dropLocation" TEXT NOT NULL,
    "dropLat" DOUBLE PRECISION,
    "dropLng" DOUBLE PRECISION,
    "vehicleCategory" TEXT NOT NULL,
    "distance" DOUBLE PRECISION,
    "duration" INTEGER,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "pickupTime" TEXT NOT NULL,
    "totalDays" INTEGER NOT NULL,
    "appBasePrice" DOUBLE PRECISION NOT NULL,
    "vendorPrice" DOUBLE PRECISION NOT NULL,
    "vendorCommission" DOUBLE PRECISION NOT NULL,
    "appCommission" DOUBLE PRECISION NOT NULL,
    "driverPayout" DOUBLE PRECISION NOT NULL,
    "vendorPayout" DOUBLE PRECISION NOT NULL,
    "driverCommissionPaid" BOOLEAN NOT NULL DEFAULT false,
    "vendorPaidAt" TIMESTAMP(3),
    "status" "VendorBookingStatus" NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "driverAcceptedAt" TIMESTAMP(3),
    "rideStartedAt" TIMESTAMP(3),
    "rideEndedAt" TIMESTAMP(3),

    CONSTRAINT "vendor_bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_booking_transactions" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "type" "VendorBookingTransactionType" NOT NULL,
    "status" "TransactionStatus" NOT NULL DEFAULT 'PENDING',
    "senderId" TEXT NOT NULL,
    "receiverId" TEXT NOT NULL,
    "description" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_booking_transactions_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "vendor_bookings" ADD CONSTRAINT "vendor_bookings_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_bookings" ADD CONSTRAINT "vendor_bookings_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_booking_transactions" ADD CONSTRAINT "vendor_booking_transactions_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "vendor_bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_booking_transactions" ADD CONSTRAINT "vendor_booking_transactions_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_booking_transactions" ADD CONSTRAINT "vendor_booking_transactions_receiverId_fkey" FOREIGN KEY ("receiverId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
