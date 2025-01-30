/*
  Warnings:

  - You are about to drop the `CarRentalPackage` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `car_rental_bookings` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `car_rental_transactions` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "car_rental_bookings" DROP CONSTRAINT "car_rental_bookings_driverId_fkey";

-- DropForeignKey
ALTER TABLE "car_rental_bookings" DROP CONSTRAINT "car_rental_bookings_packageId_fkey";

-- DropForeignKey
ALTER TABLE "car_rental_bookings" DROP CONSTRAINT "car_rental_bookings_userId_fkey";

-- DropForeignKey
ALTER TABLE "car_rental_transactions" DROP CONSTRAINT "car_rental_transactions_bookingId_fkey";

-- DropForeignKey
ALTER TABLE "car_rental_transactions" DROP CONSTRAINT "car_rental_transactions_receiverId_fkey";

-- DropForeignKey
ALTER TABLE "car_rental_transactions" DROP CONSTRAINT "car_rental_transactions_senderId_fkey";

-- DropTable
DROP TABLE "CarRentalPackage";

-- DropTable
DROP TABLE "car_rental_bookings";

-- DropTable
DROP TABLE "car_rental_transactions";

-- DropEnum
DROP TYPE "CarRentalStatus";
