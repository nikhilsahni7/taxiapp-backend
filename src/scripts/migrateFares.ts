import { RateType, ServiceType } from "@prisma/client";
import { prisma } from "../lib/prisma";

interface FareData {
  serviceType: ServiceType;
  vehicleCategory: string;
  rateType: RateType;
  packageHours?: number;
  amount: number;
}

async function migrateFares() {
  console.log("🚀 Starting fare migration...");

  try {
    // Test database connection
    await prisma.$connect();
    console.log("✅ Database connection established");

    // Clear existing fare data to avoid duplicates
    console.log("🧹 Cleaning existing fare data...");

    // Delete existing service edit logs
    const deletedLogs = await prisma.serviceEditLog.deleteMany({});
    console.log(`🗑️  Deleted ${deletedLogs.count} existing service edit logs`);

    // Delete existing fare configurations
    const deletedFares = await prisma.fareConfiguration.deleteMany({});
    console.log(
      `🗑️  Deleted ${deletedFares.count} existing fare configurations`
    );

    console.log("✨ Database cleaned successfully!");

    const allFares: FareData[] = [
      // LOCAL rates
      {
        serviceType: "LOCAL",
        vehicleCategory: "mini",
        rateType: "PER_KM_SHORT",
        amount: 17,
      },
      {
        serviceType: "LOCAL",
        vehicleCategory: "mini",
        rateType: "PER_KM_LONG",
        amount: 14,
      },
      {
        serviceType: "LOCAL",
        vehicleCategory: "sedan",
        rateType: "PER_KM_SHORT",
        amount: 23,
      },
      {
        serviceType: "LOCAL",
        vehicleCategory: "sedan",
        rateType: "PER_KM_LONG",
        amount: 17,
      },
      {
        serviceType: "LOCAL",
        vehicleCategory: "suv",
        rateType: "PER_KM_SHORT",
        amount: 35,
      },
      {
        serviceType: "LOCAL",
        vehicleCategory: "suv",
        rateType: "PER_KM_LONG",
        amount: 27,
      },

      // CAR_RENTAL - Mini
      {
        serviceType: "CAR_RENTAL",
        vehicleCategory: "mini",
        rateType: "PACKAGE_PRICE",
        packageHours: 1,
        amount: 380,
      },

      {
        serviceType: "CAR_RENTAL",
        vehicleCategory: "mini",
        rateType: "PACKAGE_PRICE",
        packageHours: 2,
        amount: 550,

      },
      {
        serviceType: "CAR_RENTAL",
        vehicleCategory: "mini",
        rateType: "PACKAGE_PRICE",
        packageHours: 3,
        amount: 700,
      },

      {
        serviceType: "CAR_RENTAL",
        vehicleCategory: "mini",
        rateType: "PACKAGE_PRICE",
        packageHours: 4,
        amount: 950,
      },

      {
        serviceType: "CAR_RENTAL",
        vehicleCategory: "mini",
        rateType: "PACKAGE_PRICE",
        packageHours: 5,
        amount: 1250,
      },

      {
        serviceType: "CAR_RENTAL",
        vehicleCategory: "mini",
        rateType: "PACKAGE_PRICE",
        packageHours: 6,
        amount: 1550,
      },

      {
        serviceType: "CAR_RENTAL",
        vehicleCategory: "mini",
        rateType: "PACKAGE_PRICE",
        packageHours: 7,
        amount: 1850,
      },

      {
        serviceType: "CAR_RENTAL",
        vehicleCategory: "mini",
        rateType: "PACKAGE_PRICE",
        packageHours: 8,
        amount: 2100,
      },


      // CAR_RENTAL - Sedan
      {
        serviceType: "CAR_RENTAL",
        vehicleCategory: "sedan",
        rateType: "PACKAGE_PRICE",
        packageHours: 1,
        amount: 450,
      },

      {
        serviceType: "CAR_RENTAL",
        vehicleCategory: "sedan",
        rateType: "PACKAGE_PRICE",
        packageHours: 2,
        amount: 600,
      },

      {
        serviceType: "CAR_RENTAL",
        vehicleCategory: "sedan",
        rateType: "PACKAGE_PRICE",
        packageHours: 3,
        amount: 850,
      },

      {
        serviceType: "CAR_RENTAL",
        vehicleCategory: "sedan",
        rateType: "PACKAGE_PRICE",
        packageHours: 4,
        amount: 1100,
      },

      {
        serviceType: "CAR_RENTAL",
        vehicleCategory: "sedan",
        rateType: "PACKAGE_PRICE",
        packageHours: 5,
        amount: 1400,
      },

      {
        serviceType: "CAR_RENTAL",
        vehicleCategory: "sedan",
        rateType: "PACKAGE_PRICE",
        packageHours: 6,
        amount: 1650,
      },

      {
        serviceType: "CAR_RENTAL",
        vehicleCategory: "sedan",
        rateType: "PACKAGE_PRICE",
        packageHours: 7,
        amount: 2000,
      },

      {
        serviceType: "CAR_RENTAL",
        vehicleCategory: "sedan",
        rateType: "PACKAGE_PRICE",
        packageHours: 8,
        amount: 2300,
      },


      // CAR_RENTAL - SUV
      {
        serviceType: "CAR_RENTAL",
        vehicleCategory: "suv",
        rateType: "PACKAGE_PRICE",
        packageHours: 1,
        amount: 580,
      },

      {
        serviceType: "CAR_RENTAL",
        vehicleCategory: "suv",
        rateType: "PACKAGE_PRICE",
        packageHours: 2,
        amount: 750,
      },

      {
        serviceType: "CAR_RENTAL",
        vehicleCategory: "suv",
        rateType: "PACKAGE_PRICE",
        packageHours: 3,
        amount: 950,
      },

      {
        serviceType: "CAR_RENTAL",
        vehicleCategory: "suv",
        rateType: "PACKAGE_PRICE",
        packageHours: 4,
        amount: 1200,
      },

      {
        serviceType: "CAR_RENTAL",
        vehicleCategory: "suv",
        rateType: "PACKAGE_PRICE",
        packageHours: 5,
        amount: 1500,
      },

      {
        serviceType: "CAR_RENTAL",
        vehicleCategory: "suv",
        rateType: "PACKAGE_PRICE",
        packageHours: 6,
        amount: 1850,
      },

      {
        serviceType: "CAR_RENTAL",
        vehicleCategory: "suv",
        rateType: "PACKAGE_PRICE",
        packageHours: 7,
        amount: 2100,
      },

      {
        serviceType: "CAR_RENTAL",
        vehicleCategory: "suv",
        rateType: "PACKAGE_PRICE",
        packageHours: 8,
        amount: 2450,
      },
  

      // OUTSTATION rates
      {
        serviceType: "OUTSTATION",
        vehicleCategory: "mini",
        rateType: "BASE_RATE",
        amount: 11,
      },
      {
        serviceType: "OUTSTATION",
        vehicleCategory: "mini",
        rateType: "PER_KM_SHORT",
        amount: 14,
      },
      {
        serviceType: "OUTSTATION",
        vehicleCategory: "sedan",
        rateType: "BASE_RATE",
        amount: 13,
      },
      {
        serviceType: "OUTSTATION",
        vehicleCategory: "sedan",
        rateType: "PER_KM_SHORT",
        amount: 19,
      },
      {
        serviceType: "OUTSTATION",
        vehicleCategory: "ertiga",
        rateType: "BASE_RATE",
        amount: 18,
      },
      {
        serviceType: "OUTSTATION",
        vehicleCategory: "ertiga",
        rateType: "PER_KM_SHORT",
        amount: 24,
      },
      {
        serviceType: "OUTSTATION",
        vehicleCategory: "innova",
        rateType: "BASE_RATE",
        amount: 21,
      },
      {
        serviceType: "OUTSTATION",
        vehicleCategory: "innova",
        rateType: "PER_KM_SHORT",
        amount: 27,
      },
      {
        serviceType: "OUTSTATION",
        vehicleCategory: "tempo_12",
        rateType: "FIXED_RATE",
        amount: 16000,
      },
      {
        serviceType: "OUTSTATION",
        vehicleCategory: "tempo_12",
        rateType: "EXTRA_KM",
        amount: 23,
      },
      {
        serviceType: "OUTSTATION",
        vehicleCategory: "tempo_16",
        rateType: "FIXED_RATE",
        amount: 18000,
      },
      {
        serviceType: "OUTSTATION",
        vehicleCategory: "tempo_16",
        rateType: "EXTRA_KM",
        amount: 26,
      },
      {
        serviceType: "OUTSTATION",
        vehicleCategory: "tempo_20",
        rateType: "FIXED_RATE",
        amount: 20000,
      },
      {
        serviceType: "OUTSTATION",
        vehicleCategory: "tempo_20",
        rateType: "EXTRA_KM",
        amount: 30,
      },
      {
        serviceType: "OUTSTATION",
        vehicleCategory: "tempo_26",
        rateType: "FIXED_RATE",
        amount: 22000,
      },
      {
        serviceType: "OUTSTATION",
        vehicleCategory: "tempo_26",
        rateType: "EXTRA_KM",
        amount: 35,
      },

      // HILL_STATION rates
      {
        serviceType: "HILL_STATION",
        vehicleCategory: "mini",
        rateType: "BASE_RATE",
        amount: 15,
      },
      {
        serviceType: "HILL_STATION",
        vehicleCategory: "sedan",
        rateType: "BASE_RATE",
        amount: 17,
      },
      {
        serviceType: "HILL_STATION",
        vehicleCategory: "ertiga",
        rateType: "BASE_RATE",
        amount: 22,
      },
      {
        serviceType: "HILL_STATION",
        vehicleCategory: "innova",
        rateType: "BASE_RATE",
        amount: 28,
      },
      {
        serviceType: "HILL_STATION",
        vehicleCategory: "tempo_12",
        rateType: "FIXED_RATE",
        amount: 16000,
      },
      {
        serviceType: "HILL_STATION",
        vehicleCategory: "tempo_12",
        rateType: "EXTRA_KM",
        amount: 23,
      },
      {
        serviceType: "HILL_STATION",
        vehicleCategory: "tempo_16",
        rateType: "FIXED_RATE",
        amount: 18000,
      },
      {
        serviceType: "HILL_STATION",
        vehicleCategory: "tempo_16",
        rateType: "EXTRA_KM",
        amount: 26,
      },
      {
        serviceType: "HILL_STATION",
        vehicleCategory: "tempo_20",
        rateType: "FIXED_RATE",
        amount: 20000,
      },
      {
        serviceType: "HILL_STATION",
        vehicleCategory: "tempo_20",
        rateType: "EXTRA_KM",
        amount: 30,
      },
      {
        serviceType: "HILL_STATION",
        vehicleCategory: "tempo_26",
        rateType: "FIXED_RATE",
        amount: 22000,
      },
      {
        serviceType: "HILL_STATION",
        vehicleCategory: "tempo_26",
        rateType: "EXTRA_KM",
        amount: 35,
      },

      // ALL_INDIA_TOUR rates
      {
        serviceType: "ALL_INDIA_TOUR",
        vehicleCategory: "mini",
        rateType: "PER_DAY",
        amount: 2800,
      },
      {
        serviceType: "ALL_INDIA_TOUR",
        vehicleCategory: "mini",
        rateType: "EXTRA_KM",
        amount: 14,
      },
      {
        serviceType: "ALL_INDIA_TOUR",
        vehicleCategory: "sedan",
        rateType: "PER_DAY",
        amount: 3500,
      },
      {
        serviceType: "ALL_INDIA_TOUR",
        vehicleCategory: "sedan",
        rateType: "EXTRA_KM",
        amount: 16,
      },
      {
        serviceType: "ALL_INDIA_TOUR",
        vehicleCategory: "ertiga",
        rateType: "PER_DAY",
        amount: 5200,
      },
      {
        serviceType: "ALL_INDIA_TOUR",
        vehicleCategory: "ertiga",
        rateType: "EXTRA_KM",
        amount: 16,
      },
      {
        serviceType: "ALL_INDIA_TOUR",
        vehicleCategory: "innova",
        rateType: "PER_DAY",
        amount: 6000,
      },
      {
        serviceType: "ALL_INDIA_TOUR",
        vehicleCategory: "innova",
        rateType: "EXTRA_KM",
        amount: 18,
      },
      {
        serviceType: "ALL_INDIA_TOUR",
        vehicleCategory: "tempo_12",
        rateType: "PER_DAY",
        amount: 8000,
      },
      {
        serviceType: "ALL_INDIA_TOUR",
        vehicleCategory: "tempo_12",
        rateType: "EXTRA_KM",
        amount: 20,
      },
      {
        serviceType: "ALL_INDIA_TOUR",
        vehicleCategory: "tempo_16",
        rateType: "PER_DAY",
        amount: 9000,
      },
      {
        serviceType: "ALL_INDIA_TOUR",
        vehicleCategory: "tempo_16",
        rateType: "EXTRA_KM",
        amount: 22,
      },
      {
        serviceType: "ALL_INDIA_TOUR",
        vehicleCategory: "tempo_20",
        rateType: "PER_DAY",
        amount: 10000,
      },
      {
        serviceType: "ALL_INDIA_TOUR",
        vehicleCategory: "tempo_20",
        rateType: "EXTRA_KM",
        amount: 24,
      },
      {
        serviceType: "ALL_INDIA_TOUR",
        vehicleCategory: "tempo_26",
        rateType: "PER_DAY",
        amount: 11000,
      },
      {
        serviceType: "ALL_INDIA_TOUR",
        vehicleCategory: "tempo_26",
        rateType: "EXTRA_KM",
        amount: 26,
      },
    ];

    console.log(`📊 Migrating ${allFares.length} fare configurations...`);

    let successCount = 0;
    let errorCount = 0;

    // Process records in smaller batches to avoid transaction timeouts
    const batchSize = 10;
    for (let i = 0; i < allFares.length; i += batchSize) {
      const batch = allFares.slice(i, i + batchSize);

      // Process each batch in a transaction
      await prisma.$transaction(async (tx) => {
        for (const fare of batch) {
          try {
            // Try to find existing record
            const existingFare = await tx.fareConfiguration.findFirst({
              where: {
                serviceType: fare.serviceType,
                vehicleCategory: fare.vehicleCategory,
                rateType: fare.rateType,
                packageHours: fare.packageHours ?? null,
              },
            });

            if (existingFare) {
              // Update existing record
              await tx.fareConfiguration.update({
                where: { id: existingFare.id },
                data: {
                  amount: fare.amount,
                  isActive: true,
                  lastEditedBy: "SYSTEM",
                  lastEditedAt: new Date(),
                },
              });
            } else {
              // Create new record
              await tx.fareConfiguration.create({
                data: {
                  serviceType: fare.serviceType,
                  vehicleCategory: fare.vehicleCategory,
                  rateType: fare.rateType,
                  packageHours: fare.packageHours ?? null,
                  amount: fare.amount,
                  lastEditedBy: "SYSTEM",
                  lastEditedAt: new Date(),
                },
              });
            }

            successCount++;
            console.log(
              `✅ Migrated: ${fare.serviceType} - ${fare.vehicleCategory} - ${fare.rateType}${fare.packageHours ? ` (${fare.packageHours}h)` : ""}`
            );
          } catch (error) {
            console.error(`❌ Error migrating fare:`, fare, error);
            errorCount++;
            throw error; // Will rollback the current batch transaction
          }
        }
      });

      console.log(
        `📦 Completed batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(allFares.length / batchSize)}`
      );
    }

    console.log(`✅ Migration completed successfully!`);
    console.log(`📊 Statistics:`);
    console.log(`   - Total fares: ${allFares.length}`);
    console.log(`   - Successfully migrated: ${successCount}`);
    console.log(`   - Errors: ${errorCount}`);

    // Create initial edit logs for each service
    const services: ServiceType[] = [
      "LOCAL",
      "CAR_RENTAL",
      "OUTSTATION",
      "HILL_STATION",
      "ALL_INDIA_TOUR",
    ];

    for (const service of services) {
      const serviceCount = allFares.filter(
        (fare) => fare.serviceType === service
      ).length;
      try {
        await prisma.serviceEditLog.create({
          data: {
            serviceType: service,
            editedBy: "SYSTEM",
            changesCount: serviceCount,
            editSummary: {
              action: "INITIAL_MIGRATION",
              message: `Initial migration of ${serviceCount} rates for ${service} service`,
            },
          },
        });
        console.log(`📝 Created edit log for ${service} service`);
      } catch (error) {
        console.error(`❌ Error creating edit log for ${service}:`, error);
      }
    }

    console.log(`🎉 All done! Your dynamic fare system is ready to use.`);
  } catch (error) {
    console.error("❌ Migration failed:", error);
    throw error;
  } finally {
    await prisma.$disconnect();
    console.log("📴 Database connection closed");
  }
}

// Run the migration if this file is executed directly
if (require.main === module) {
  migrateFares()
    .then(() => {
      console.log("Migration completed successfully");
      process.exit(0);
    })
    .catch((error) => {
      console.error("Migration failed:", error);
      process.exit(1);
    });
}

export { migrateFares };
