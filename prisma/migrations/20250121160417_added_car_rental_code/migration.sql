-- CreateEnum
CREATE TYPE "CarRentalStatus" AS ENUM ('SEARCHING', 'ACCEPTED', 'DRIVER_ARRIVED', 'STARTED', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "CarRentalPackage" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hours" INTEGER NOT NULL,
    "kilometers" INTEGER NOT NULL,
    "basePrice" DOUBLE PRECISION NOT NULL,
    "carType" TEXT NOT NULL,
    "extraKmRate" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CarRentalPackage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "car_rental_bookings" (
    "id" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "driverId" TEXT,
    "status" "CarRentalStatus" NOT NULL DEFAULT 'SEARCHING',
    "pickupLocation" TEXT NOT NULL,
    "pickupLat" DOUBLE PRECISION NOT NULL,
    "pickupLng" DOUBLE PRECISION NOT NULL,
    "pickupDistance" DOUBLE PRECISION,
    "pickupDuration" INTEGER,
    "hours" INTEGER NOT NULL,
    "kilometers" INTEGER NOT NULL,
    "carType" TEXT NOT NULL,
    "baseAmount" DOUBLE PRECISION NOT NULL,
    "startTime" TIMESTAMP(3),
    "endTime" TIMESTAMP(3),
    "totalDistance" DOUBLE PRECISION,
    "extraKms" DOUBLE PRECISION,
    "extraMinutes" INTEGER,
    "extraCharges" DOUBLE PRECISION,
    "finalAmount" DOUBLE PRECISION,
    "paymentMode" "PaymentMode" NOT NULL DEFAULT 'CASH',
    "paymentStatus" "TransactionStatus" NOT NULL DEFAULT 'PENDING',
    "razorpayOrderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "driverAcceptedAt" TIMESTAMP(3),
    "driverArrivedAt" TIMESTAMP(3),
    "rideStartedAt" TIMESTAMP(3),
    "rideEndedAt" TIMESTAMP(3),

    CONSTRAINT "car_rental_bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "car_rental_transactions" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "type" "TransactionType" NOT NULL,
    "status" "TransactionStatus" NOT NULL DEFAULT 'PENDING',
    "senderId" TEXT NOT NULL,
    "receiverId" TEXT NOT NULL,
    "razorpayOrderId" TEXT,
    "razorpayPaymentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "car_rental_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "car_rental_bookings_razorpayOrderId_key" ON "car_rental_bookings"("razorpayOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "car_rental_transactions_razorpayOrderId_key" ON "car_rental_transactions"("razorpayOrderId");

-- AddForeignKey
ALTER TABLE "car_rental_bookings" ADD CONSTRAINT "car_rental_bookings_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "CarRentalPackage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "car_rental_bookings" ADD CONSTRAINT "car_rental_bookings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "car_rental_bookings" ADD CONSTRAINT "car_rental_bookings_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "car_rental_transactions" ADD CONSTRAINT "car_rental_transactions_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "car_rental_bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "car_rental_transactions" ADD CONSTRAINT "car_rental_transactions_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "car_rental_transactions" ADD CONSTRAINT "car_rental_transactions_receiverId_fkey" FOREIGN KEY ("receiverId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
