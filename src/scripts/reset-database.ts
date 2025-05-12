import { PrismaClient } from "@prisma/client";
import { exit } from "process";

const prisma = new PrismaClient();

/**
 * Resets the database using Prisma's executeRaw functionality
 * This directly executes SQL to truncate all tables in the proper order
 * More efficient than individual deleteMany operations
 */
async function resetDatabase() {
  console.log("🔄 Starting database reset process using SQL TRUNCATE...");

  try {
    // Execute all truncates within a single transaction
    await prisma.$transaction(async (tx) => {
      // Disable foreign key checks temporarily
      await tx.$executeRawUnsafe(`SET CONSTRAINTS ALL DEFERRED;`);

      // First level tables (no foreign keys pointing to them)
      await tx.$executeRawUnsafe(`TRUNCATE TABLE "ChatMessage" CASCADE;`);
      await tx.$executeRawUnsafe(`TRUNCATE TABLE "RideLocationLog" CASCADE;`);
      await tx.$executeRawUnsafe(
        `TRUNCATE TABLE "vendor_booking_transactions" CASCADE;`
      );
      await tx.$executeRawUnsafe(
        `TRUNCATE TABLE "LongDistanceTransaction" CASCADE;`
      );
      await tx.$executeRawUnsafe(`TRUNCATE TABLE "Transaction" CASCADE;`);

      // Second level tables
      await tx.$executeRawUnsafe(`TRUNCATE TABLE "vendor_bookings" CASCADE;`);
      await tx.$executeRawUnsafe(
        `TRUNCATE TABLE "LongDistanceBooking" CASCADE;`
      );
      await tx.$executeRawUnsafe(`TRUNCATE TABLE "Ride" CASCADE;`);
      await tx.$executeRawUnsafe(`TRUNCATE TABLE "OTP" CASCADE;`);

      // Third level tables
      await tx.$executeRawUnsafe(`TRUNCATE TABLE "Wallet" CASCADE;`);
      await tx.$executeRawUnsafe(`TRUNCATE TABLE "DriverStatus" CASCADE;`);
      await tx.$executeRawUnsafe(`TRUNCATE TABLE "VendorDetails" CASCADE;`);
      await tx.$executeRawUnsafe(`TRUNCATE TABLE "DriverDetails" CASCADE;`);
      await tx.$executeRawUnsafe(`TRUNCATE TABLE "UserDetails" CASCADE;`);

      // Final level tables
      await tx.$executeRawUnsafe(`TRUNCATE TABLE "User" CASCADE;`);

      // Re-enable foreign key checks
      await tx.$executeRawUnsafe(`SET CONSTRAINTS ALL IMMEDIATE;`);
    });

    console.log("✅ Database reset successfully using SQL TRUNCATE!");
    return true;
  } catch (error) {
    console.error("❌ Error resetting database:", error);
    return false;
  } finally {
    await prisma.$disconnect();
  }
}

// Execute if run directly
if (require.main === module) {
  resetDatabase()
    .then((success) => {
      if (success) {
        console.log("Database reset completed.");
        exit(0);
      } else {
        console.error("Database reset failed.");
        exit(1);
      }
    })
    .catch((err) => {
      console.error("Unexpected error:", err);
      exit(1);
    });
}

export { resetDatabase };
