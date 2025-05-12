import { exec } from "child_process";
import { exit } from "process";
import { promisify } from "util";

const execPromise = promisify(exec);

/**
 * Performs a complete database reset:
 * 1. Drops all tables
 * 2. Recreates schema from prisma schema
 */
async function fullDatabaseReset() {
  console.log("🔄 Starting full database reset (data + schema)...");

  try {
    // Step 1: Drop database schema
    console.log("📥 Dropping existing database schema...");
    await execPromise(
      "npx prisma migrate reset --force --skip-seed --skip-generate"
    );

    // Step 2: Apply migrations to create fresh schema
    console.log("📤 Applying migrations to create fresh schema...");
    await execPromise("npx prisma migrate deploy");

    // Step 3: Generate Prisma client
    console.log("🔧 Generating Prisma client...");
    await execPromise("npx prisma generate");

    console.log("✅ Full database reset completed successfully!");
    return true;
  } catch (error) {
    console.error("❌ Error performing full database reset:", error);
    console.error(error.stdout);
    console.error(error.stderr);
    return false;
  }
}

// Execute if run directly
if (require.main === module) {
  fullDatabaseReset()
    .then((success) => {
      if (success) {
        console.log("Database has been completely reset with a fresh schema.");
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

export { fullDatabaseReset };
