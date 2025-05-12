import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/**
 * Clears all data from the database while preserving schema
 * Deletes in proper order to respect foreign key constraints
 */
async function clearDatabase() {
  console.log("🗑️  Starting database clearing process...");

  try {
    // First level: Delete records without dependencies
    console.log("Clearing ChatMessage records...");
    await prisma.chatMessage.deleteMany();

    console.log("Clearing RideLocationLog records...");
    await prisma.rideLocationLog.deleteMany();

    console.log("Clearing VendorBookingTransaction records...");
    await prisma.vendorBookingTransaction.deleteMany();

    console.log("Clearing LongDistanceTransaction records...");
    await prisma.longDistanceTransaction.deleteMany();

    console.log("Clearing Transaction records...");
    await prisma.transaction.deleteMany();

    // Second level: Delete records with simple dependencies
    console.log("Clearing VendorBooking records...");
    await prisma.vendorBooking.deleteMany();

    console.log("Clearing LongDistanceBooking records...");
    await prisma.longDistanceBooking.deleteMany();

    console.log("Clearing Ride records...");
    await prisma.ride.deleteMany();

    console.log("Clearing OTP records...");
    await prisma.oTP.deleteMany();

    // Third level: Delete remaining user-related records
    console.log("Clearing Wallet records...");
    await prisma.wallet.deleteMany();

    console.log("Clearing DriverStatus records...");
    await prisma.driverStatus.deleteMany();

    console.log("Clearing VendorDetails records...");
    await prisma.vendorDetails.deleteMany();

    console.log("Clearing DriverDetails records...");
    await prisma.driverDetails.deleteMany();

    console.log("Clearing UserDetails records...");
    await prisma.userDetails.deleteMany();

    // Final level: Delete users
    console.log("Clearing User records...");
    await prisma.user.deleteMany();

    console.log(
      "✅ Database cleared successfully! All data has been removed while preserving schema."
    );
    return true;
  } catch (error: any) {
    console.error("❌ Error clearing database:", error);
    console.error(error.message || error);
    return false;
  } finally {
    await prisma.$disconnect();
  }
}

export { clearDatabase };
