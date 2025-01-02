-- CreateEnum
CREATE TYPE "LongDistanceServiceType" AS ENUM ('OUTSTATION', 'HILL_STATION', 'ALL_INDIA_TOUR', 'CHARDHAM_YATRA');

-- CreateEnum
CREATE TYPE "LongDistanceBookingStatus" AS ENUM ('PENDING', 'DRIVER_ACCEPTED', 'ADVANCE_PAID', 'DRIVER_PICKUP_STARTED', 'DRIVER_ARRIVED', 'STARTED', 'PAYMENT_PENDING', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LongDistanceTransactionType" AS ENUM ('BOOKING_ADVANCE', 'BOOKING_FINAL', 'REFUND');

-- CreateTable
CREATE TABLE "LongDistanceBooking" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "driverId" TEXT,
    "serviceType" "LongDistanceServiceType" NOT NULL,
    "pickupLocation" TEXT NOT NULL,
    "dropLocation" TEXT,
    "vehicleCategory" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "pickupTime" TEXT NOT NULL,
    "totalDays" INTEGER NOT NULL,
    "pickupDistance" DOUBLE PRECISION,
    "pickupDuration" INTEGER,
    "baseAmount" DOUBLE PRECISION NOT NULL,
    "taxAmount" DOUBLE PRECISION NOT NULL,
    "totalAmount" DOUBLE PRECISION NOT NULL,
    "advanceAmount" DOUBLE PRECISION NOT NULL,
    "remainingAmount" DOUBLE PRECISION NOT NULL,
    "advancePaymentId" TEXT,
    "finalPaymentId" TEXT,
    "finalPaymentMode" "PaymentMode" DEFAULT 'CASH',
    "advancePaymentStatus" "TransactionStatus" NOT NULL DEFAULT 'PENDING',
    "finalPaymentStatus" "TransactionStatus" NOT NULL DEFAULT 'PENDING',
    "status" "LongDistanceBookingStatus" NOT NULL DEFAULT 'PENDING',
    "otp" TEXT,
    "tripType" "OutstationTripType",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "driverAcceptedAt" TIMESTAMP(3),
    "advancePaidAt" TIMESTAMP(3),
    "driverArrivedAt" TIMESTAMP(3),
    "rideStartedAt" TIMESTAMP(3),
    "rideEndedAt" TIMESTAMP(3),
    "notes" TEXT,
    "cancelReason" TEXT,
    "metadata" JSONB,

    CONSTRAINT "LongDistanceBooking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LongDistanceTransaction" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "type" "LongDistanceTransactionType" NOT NULL,
    "status" "TransactionStatus" NOT NULL DEFAULT 'PENDING',
    "senderId" TEXT,
    "receiverId" TEXT,
    "razorpayOrderId" TEXT,
    "razorpayPaymentId" TEXT,
    "description" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LongDistanceTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LongDistanceTransaction_razorpayOrderId_key" ON "LongDistanceTransaction"("razorpayOrderId");

-- AddForeignKey
ALTER TABLE "LongDistanceBooking" ADD CONSTRAINT "LongDistanceBooking_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LongDistanceBooking" ADD CONSTRAINT "LongDistanceBooking_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LongDistanceTransaction" ADD CONSTRAINT "LongDistanceTransaction_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "LongDistanceBooking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LongDistanceTransaction" ADD CONSTRAINT "LongDistanceTransaction_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LongDistanceTransaction" ADD CONSTRAINT "LongDistanceTransaction_receiverId_fkey" FOREIGN KEY ("receiverId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
