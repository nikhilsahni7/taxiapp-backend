import { PrismaClient, UserType } from "@prisma/client";
import * as fs from "fs";
import * as path from "path";

/**
 * Utility script to pretty print all users, drivers, and vendors with their details
 * Helps visualize the complete data structure for debugging/verification purposes
 */

// ANSI color codes for terminal output
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  underscore: "\x1b[4m",
  blink: "\x1b[5m",
  reverse: "\x1b[7m",
  hidden: "\x1b[8m",
  // Foreground (text) colors
  fg: {
    black: "\x1b[30m",
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    magenta: "\x1b[35m",
    cyan: "\x1b[36m",
    white: "\x1b[37m",
  },
  // Background colors
  bg: {
    black: "\x1b[40m",
    red: "\x1b[41m",
    green: "\x1b[42m",
    yellow: "\x1b[43m",
    blue: "\x1b[44m",
    magenta: "\x1b[45m",
    cyan: "\x1b[46m",
    white: "\x1b[47m",
  },
};

// Helper to truncate text for display
const truncate = (str: string | null | undefined, length: number): string => {
  if (!str) return "";
  return str.length > length ? str.substring(0, length) + "..." : str;
};

// Parse command line arguments
const args = process.argv.slice(2);
const options = {
  format: args.includes("--json") ? "json" : "table",
  outputFile: args.includes("--out")
    ? args[args.indexOf("--out") + 1]
    : "user-data-export.json",
  showAll: args.includes("--all"),
  userType: args.includes("--users")
    ? "users"
    : args.includes("--drivers")
      ? "drivers"
      : args.includes("--vendors")
        ? "vendors"
        : args.includes("--admins")
          ? "admins"
          : "all",
};

async function main() {
  console.log(
    `${colors.bright}${colors.fg.cyan}Starting data export...${colors.reset}`
  );

  // Initialize Prisma client
  const prisma = new PrismaClient();

  try {
    // Get all users with their details
    const users = await prisma.user.findMany({
      include: {
        userDetails: true,
        driverDetails: true,
        vendorDetails: true,
        wallet: true,
        ridesAsUser: {
          take: 5, // Limit to 5 most recent rides
          orderBy: { createdAt: "desc" },
        },
        ridesAsDriver: {
          take: 5, // Limit to 5 most recent rides
          orderBy: { createdAt: "desc" },
        },
        driverStatus: true,
      },
    });

    // Format and group users by type
    const regularUsers = users.filter(
      (user) => user.userType === UserType.USER
    );
    const drivers = users.filter((user) => user.userType === UserType.DRIVER);
    const vendors = users.filter((user) => user.userType === UserType.VENDOR);
    const admins = users.filter((user) => user.userType === UserType.ADMIN);

    // Create formatted output
    const output = {
      stats: {
        totalUsers: users.length,
        regularUsers: regularUsers.length,
        drivers: drivers.length,
        vendors: vendors.length,
        admins: admins.length,
      },
      regularUsers: formatUsers(regularUsers),
      drivers: formatDrivers(drivers),
      vendors: formatVendors(vendors),
      admins: formatUsers(admins),
    };

    // Print summary to console
    console.log(
      `\n${colors.bright}${colors.fg.green}=== DATABASE SUMMARY ===${colors.reset}`
    );
    console.log(`Total Users: ${output.stats.totalUsers}`);
    console.log(`- Regular Users: ${output.stats.regularUsers}`);
    console.log(`- Drivers: ${output.stats.drivers}`);
    console.log(`- Vendors: ${output.stats.vendors}`);
    console.log(`- Admins: ${output.stats.admins}`);

    // Handle different output formats
    if (options.format === "json") {
      // Save to JSON file
      const outputPath =
        options.outputFile || path.join(process.cwd(), "user-data-export.json");
      fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
      console.log(
        `\n${colors.fg.green}Data exported to ${outputPath}${colors.reset}`
      );
    } else {
      // Print to console in table format
      if (options.userType === "all" || options.userType === "users") {
        printUsersTable(regularUsers, "REGULAR USERS");
      }

      if (options.userType === "all" || options.userType === "drivers") {
        printDriversTable(drivers);
      }

      if (options.userType === "all" || options.userType === "vendors") {
        printVendorsTable(vendors);
      }

      if (options.userType === "all" || options.userType === "admins") {
        printUsersTable(admins, "ADMIN USERS");
      }
    }
  } catch (error) {
    console.error(
      `${colors.fg.red}Error exporting data:${colors.reset}`,
      error
    );
  } finally {
    // Disconnect Prisma client
    await prisma.$disconnect();
  }
}

/**
 * Format regular users for output
 */
function formatUsers(users: any[]) {
  return users.map((user) => ({
    id: user.id,
    name: user.name,
    phone: user.phone,
    email: user.email,
    verified: user.verified,
    state: user.state,
    city: user.city,
    selfieUrl: user.selfieUrl,
    createdAt: user.createdAt,
    wallet: user.wallet
      ? {
          balance: user.wallet.balance,
          currency: user.wallet.currency,
        }
      : null,
    userDetails: user.userDetails,
  }));
}

/**
 * Format drivers with their specific details
 */
function formatDrivers(drivers: any[]) {
  return drivers.map((driver) => ({
    id: driver.id,
    name: driver.name,
    phone: driver.phone,
    email: driver.email,
    verified: driver.verified,
    state: driver.state,
    city: driver.city,
    selfieUrl: driver.selfieUrl,
    createdAt: driver.createdAt,
    wallet: driver.wallet
      ? {
          balance: driver.wallet.balance,
          currency: driver.wallet.currency,
        }
      : null,
    driverDetails: {
      ...driver.driverDetails,
      documentUrls: {
        dlUrl: driver.driverDetails?.dlUrl,
        permitUrls: driver.driverDetails?.permitUrls,
        rcUrl: driver.driverDetails?.rcUrl,
        fitnessUrl: driver.driverDetails?.fitnessUrl,
        pollutionUrl: driver.driverDetails?.pollutionUrl,
        insuranceUrl: driver.driverDetails?.insuranceUrl,
        carFrontUrl: driver.driverDetails?.carFrontUrl,
        carBackUrl: driver.driverDetails?.carBackUrl,
      },
    },
    driverStatus: driver.driverStatus
      ? {
          isOnline: driver.driverStatus.isOnline,
          lastLocationUpdate: driver.driverStatus.lastLocationUpdate,
          location:
            driver.driverStatus.locationLat && driver.driverStatus.locationLng
              ? `${driver.driverStatus.locationLat},${driver.driverStatus.locationLng}`
              : null,
        }
      : null,
    recentRides: formatRides(driver.ridesAsDriver),
  }));
}

/**
 * Format vendors with their specific details
 */
function formatVendors(vendors: any[]) {
  return vendors.map((vendor) => ({
    id: vendor.id,
    name: vendor.name,
    phone: vendor.phone,
    email: vendor.email,
    verified: vendor.verified,
    state: vendor.state,
    city: vendor.city,
    selfieUrl: vendor.selfieUrl,
    createdAt: vendor.createdAt,
    wallet: vendor.wallet
      ? {
          balance: vendor.wallet.balance,
          currency: vendor.wallet.currency,
        }
      : null,
    vendorDetails: {
      ...vendor.vendorDetails,
      documentUrls: {
        aadharFrontUrl: vendor.vendorDetails?.aadharFrontUrl,
        aadharBackUrl: vendor.vendorDetails?.aadharBackUrl,
        panUrl: vendor.vendorDetails?.panUrl,
      },
    },
  }));
}

/**
 * Format rides information
 */
function formatRides(rides: any[]) {
  return rides.map((ride) => ({
    id: ride.id,
    status: ride.status,
    pickup: ride.pickupLocation,
    drop: ride.dropLocation,
    fare: ride.fare,
    distance: ride.distance,
    createdAt: ride.createdAt,
  }));
}

/**
 * Print a table of users to the console
 */
function printUsersTable(users: any[], title: string) {
  console.log(
    `\n${colors.bg.blue}${colors.fg.white}${colors.bright} ${title} (${users.length}) ${colors.reset}\n`
  );

  if (users.length === 0) {
    console.log(`${colors.fg.yellow}No users found${colors.reset}`);
    return;
  }

  // Print table header
  console.log(
    `${colors.bright}${"ID".padEnd(10)} | ${"NAME".padEnd(20)} | ${"PHONE".padEnd(15)} | ${"EMAIL".padEnd(25)} | ${"VERIFIED".padEnd(10)} | ${"WALLET".padEnd(10)}${colors.reset}`
  );
  console.log("-".repeat(100));

  // Print each user
  users.forEach((user) => {
    const verified = user.verified
      ? `${colors.fg.green}Yes${colors.reset}`
      : `${colors.fg.red}No${colors.reset}`;

    const wallet = user.wallet
      ? `${colors.fg.green}${user.wallet.balance} ${user.wallet.currency}${colors.reset}`
      : `${colors.fg.red}None${colors.reset}`;

    console.log(
      `${truncate(user.id, 8).padEnd(10)} | ` +
        `${truncate(user.name || "N/A", 18).padEnd(20)} | ` +
        `${truncate(user.phone, 13).padEnd(15)} | ` +
        `${truncate(user.email || "N/A", 23).padEnd(25)} | ` +
        `${verified.padEnd(10)} | ` +
        `${wallet.padEnd(10)}`
    );
  });
}

/**
 * Print a table of drivers to the console
 */
function printDriversTable(drivers: any[]) {
  console.log(
    `\n${colors.bg.green}${colors.fg.black}${colors.bright} DRIVERS (${drivers.length}) ${colors.reset}\n`
  );

  if (drivers.length === 0) {
    console.log(`${colors.fg.yellow}No drivers found${colors.reset}`);
    return;
  }

  // Print each driver with details
  drivers.forEach((driver, index) => {
    console.log(
      `${colors.bg.cyan}${colors.fg.black} DRIVER #${index + 1} ${colors.reset}`
    );
    console.log(`${colors.bright}ID:${colors.reset} ${driver.id}`);
    console.log(`${colors.bright}Name:${colors.reset} ${driver.name || "N/A"}`);
    console.log(`${colors.bright}Phone:${colors.reset} ${driver.phone}`);
    console.log(
      `${colors.bright}Email:${colors.reset} ${driver.email || "N/A"}`
    );
    console.log(
      `${colors.bright}Verified:${colors.reset} ${driver.verified ? colors.fg.green + "Yes" + colors.reset : colors.fg.red + "No" + colors.reset}`
    );
    console.log(
      `${colors.bright}Wallet:${colors.reset} ${driver.wallet ? colors.fg.green + driver.wallet.balance + " " + driver.wallet.currency + colors.reset : colors.fg.red + "None" + colors.reset}`
    );

    if (driver.driverDetails) {
      console.log(
        `\n${colors.fg.yellow}${colors.bright}Driver Details:${colors.reset}`
      );
      console.log(
        `${colors.bright}Vehicle:${colors.reset} ${driver.driverDetails.vehicleName || "N/A"} (${driver.driverDetails.vehicleNumber || "N/A"})`
      );
      console.log(
        `${colors.bright}Category:${colors.reset} ${driver.driverDetails.vehicleCategory || "N/A"}`
      );
      console.log(
        `${colors.bright}Has Carrier:${colors.reset} ${driver.driverDetails.hasCarrier ? "Yes" : "No"}`
      );
      console.log(
        `${colors.bright}Registration Fee Paid:${colors.reset} ${driver.driverDetails.registrationFeePaid ? colors.fg.green + "Yes" + colors.reset : colors.fg.red + "No" + colors.reset}`
      );

      // Print document links
      console.log(
        `\n${colors.fg.magenta}${colors.bright}Document URLs:${colors.reset}`
      );
      console.log(
        `${colors.bright}DL URL:${colors.reset} ${driver.driverDetails.dlUrl || "N/A"}`
      );
      console.log(
        `${colors.bright}RC URL:${colors.reset} ${driver.driverDetails.rcUrl || "N/A"}`
      );
      console.log(
        `${colors.bright}Fitness URL:${colors.reset} ${driver.driverDetails.fitnessUrl || "N/A"}`
      );
      console.log(
        `${colors.bright}Pollution URL:${colors.reset} ${driver.driverDetails.pollutionUrl || "N/A"}`
      );
      console.log(
        `${colors.bright}Insurance URL:${colors.reset} ${driver.driverDetails.insuranceUrl || "N/A"}`
      );
      console.log(
        `${colors.bright}Car Front URL:${colors.reset} ${driver.driverDetails.carFrontUrl || "N/A"}`
      );
      console.log(
        `${colors.bright}Car Back URL:${colors.reset} ${driver.driverDetails.carBackUrl || "N/A"}`
      );

      if (
        driver.driverDetails.permitUrls &&
        driver.driverDetails.permitUrls.length > 0
      ) {
        console.log(`${colors.bright}Permit URLs:${colors.reset}`);
        driver.driverDetails.permitUrls.forEach((url: string, i: number) => {
          console.log(`  ${i + 1}. ${url}`);
        });
      }
    }

    if (driver.driverStatus) {
      console.log(
        `\n${colors.fg.cyan}${colors.bright}Driver Status:${colors.reset}`
      );
      console.log(
        `${colors.bright}Online:${colors.reset} ${driver.driverStatus.isOnline ? colors.fg.green + "Yes" + colors.reset : colors.fg.red + "No" + colors.reset}`
      );
      console.log(
        `${colors.bright}Last Update:${colors.reset} ${driver.driverStatus.lastLocationUpdate || "N/A"}`
      );
      console.log(
        `${colors.bright}Location:${colors.reset} ${driver.driverStatus.location || "N/A"}`
      );
    }

    if (driver.recentRides && driver.recentRides.length > 0) {
      console.log(
        `\n${colors.fg.blue}${colors.bright}Recent Rides:${colors.reset}`
      );
      driver.recentRides.forEach((ride: any, i: number) => {
        console.log(
          `  ${i + 1}. ${ride.id} - ${ride.status} - ${ride.pickup} to ${ride.drop} - ${ride.fare || "N/A"}`
        );
      });
    }

    console.log("-".repeat(100));
  });
}

/**
 * Print a table of vendors to the console
 */
function printVendorsTable(vendors: any[]) {
  console.log(
    `\n${colors.bg.magenta}${colors.fg.white}${colors.bright} VENDORS (${vendors.length}) ${colors.reset}\n`
  );

  if (vendors.length === 0) {
    console.log(`${colors.fg.yellow}No vendors found${colors.reset}`);
    return;
  }

  // Print each vendor with details
  vendors.forEach((vendor, index) => {
    console.log(
      `${colors.bg.yellow}${colors.fg.black} VENDOR #${index + 1} ${colors.reset}`
    );
    console.log(`${colors.bright}ID:${colors.reset} ${vendor.id}`);
    console.log(`${colors.bright}Name:${colors.reset} ${vendor.name || "N/A"}`);
    console.log(`${colors.bright}Phone:${colors.reset} ${vendor.phone}`);
    console.log(
      `${colors.bright}Email:${colors.reset} ${vendor.email || "N/A"}`
    );
    console.log(
      `${colors.bright}Verified:${colors.reset} ${vendor.verified ? colors.fg.green + "Yes" + colors.reset : colors.fg.red + "No" + colors.reset}`
    );
    console.log(
      `${colors.bright}Wallet:${colors.reset} ${vendor.wallet ? colors.fg.green + vendor.wallet.balance + " " + vendor.wallet.currency + colors.reset : colors.fg.red + "None" + colors.reset}`
    );

    if (vendor.vendorDetails) {
      console.log(
        `\n${colors.fg.yellow}${colors.bright}Vendor Details:${colors.reset}`
      );
      console.log(
        `${colors.bright}Business Name:${colors.reset} ${vendor.vendorDetails.businessName || "N/A"}`
      );
      console.log(
        `${colors.bright}Address:${colors.reset} ${vendor.vendorDetails.address || "N/A"}`
      );
      console.log(
        `${colors.bright}Experience:${colors.reset} ${vendor.vendorDetails.experience || "N/A"}`
      );
      console.log(
        `${colors.bright}GST Number:${colors.reset} ${vendor.vendorDetails.gstNumber || "N/A"}`
      );
      console.log(
        `${colors.bright}Aadhar Number:${colors.reset} ${vendor.vendorDetails.aadharNumber || "N/A"}`
      );
      console.log(
        `${colors.bright}PAN Number:${colors.reset} ${vendor.vendorDetails.panNumber || "N/A"}`
      );

      // Print document links
      console.log(
        `\n${colors.fg.magenta}${colors.bright}Document URLs:${colors.reset}`
      );
      console.log(
        `${colors.bright}Aadhar Front URL:${colors.reset} ${vendor.vendorDetails.documentUrls.aadharFrontUrl || "N/A"}`
      );
      console.log(
        `${colors.bright}Aadhar Back URL:${colors.reset} ${vendor.vendorDetails.documentUrls.aadharBackUrl || "N/A"}`
      );
      console.log(
        `${colors.bright}PAN URL:${colors.reset} ${vendor.vendorDetails.documentUrls.panUrl || "N/A"}`
      );
    }

    console.log("-".repeat(100));
  });
}

// Print usage instructions
function printUsage() {
  console.log(`
${colors.bright}${colors.fg.cyan}Database Data Printer Utility${colors.reset}

${colors.bright}Usage:${colors.reset}
  bun run src/scripts/print-users-data.ts [options]

${colors.bright}Options:${colors.reset}
  --json              Output as JSON file instead of console tables
  --out <filename>    Specify output filename for JSON (default: user-data-export.json)
  --all               Show all details (including document URLs)
  --users             Show only regular users
  --drivers           Show only drivers
  --vendors           Show only vendors
  --admins            Show only admins
  `);
}

// Check if help is requested
if (args.includes("--help") || args.includes("-h")) {
  printUsage();
  process.exit(0);
}

// Execute the script
main()
  .then(() =>
    console.log(
      `\n${colors.fg.green}${colors.bright}Export completed successfully${colors.reset}`
    )
  )
  .catch((error) =>
    console.error(
      `\n${colors.fg.red}${colors.bright}Export failed:${colors.reset}`,
      error
    )
  );
