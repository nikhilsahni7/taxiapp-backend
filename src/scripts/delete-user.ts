import { PrismaClient } from "@prisma/client";
import readline from "readline";

const prisma = new PrismaClient();

// Create readline interface for command line input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

async function deleteUser(userId: string): Promise<void> {
  console.log(`Starting deletion process for user ${userId}...`);

  try {
    // First, get the user to confirm they exist and get their type
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        driverDetails: true,
        vendorDetails: true,
        userDetails: true,
      },
    });

    if (!user) {
      console.error(`User with ID ${userId} not found.`);
      return;
    }

    console.log(
      `Found user: ${user.name || "Unnamed"} (${user.phone}) - Type: ${user.userType}`
    );

    // Use a longer transaction timeout to prevent "Transaction already closed" errors
    await prisma.$transaction(
      async (tx) => {
        // 1. Delete ChatMessages sent by the user
        const chatMessagesDeleted = await tx.chatMessage.deleteMany({
          where: { senderId: userId },
        });
        console.log(`Deleted ${chatMessagesDeleted.count} chat messages`);

        // 2. Delete RideLocationLogs for rides where user is driver
        if (user.userType === "DRIVER") {
          // Get all rides where this user was the driver
          const driverRides = await tx.ride.findMany({
            where: { driverId: userId },
            select: { id: true },
          });

          const rideIds = driverRides.map((ride) => ride.id);

          if (rideIds.length > 0) {
            const locationLogsDeleted = await tx.rideLocationLog.deleteMany({
              where: { rideId: { in: rideIds } },
            });
            console.log(
              `Deleted ${locationLogsDeleted.count} ride location logs`
            );
          }
        }

        // 3. Delete Transactions where user is sender or receiver
        const transactionsDeleted = await tx.transaction.deleteMany({
          where: {
            OR: [{ senderId: userId }, { receiverId: userId }],
          },
        });
        console.log(`Deleted ${transactionsDeleted.count} transactions`);

        // 4. Delete LongDistanceTransactions where user is sender or receiver
        const ldTransactionsDeleted =
          await tx.longDistanceTransaction.deleteMany({
            where: {
              OR: [{ senderId: userId }, { receiverId: userId }],
            },
          });
        console.log(
          `Deleted ${ldTransactionsDeleted.count} long distance transactions`
        );

        // 5. Delete VendorBookingTransactions where user is sender or receiver
        const vbTransactionsDeleted =
          await tx.vendorBookingTransaction.deleteMany({
            where: {
              OR: [{ senderId: userId }, { receiverId: userId }],
            },
          });
        console.log(
          `Deleted ${vbTransactionsDeleted.count} vendor booking transactions`
        );

        // 6. Handle Rides
        // First get all ride IDs where this user is involved (either as user or driver)
        const rideIdsToDelete = await tx.ride.findMany({
          where: {
            OR: [{ userId: userId }, { driverId: userId }],
          },
          select: { id: true },
        });

        const rideIds = rideIdsToDelete.map((ride) => ride.id);

        if (rideIds.length > 0) {
          // Delete all chat messages for these rides
          const rideChatsDeleted = await tx.chatMessage.deleteMany({
            where: { rideId: { in: rideIds } },
          });
          console.log(`Deleted ${rideChatsDeleted.count} ride chat messages`);

          // Delete all location logs for these rides
          const logsDeleted = await tx.rideLocationLog.deleteMany({
            where: { rideId: { in: rideIds } },
          });
          console.log(`Deleted ${logsDeleted.count} ride location logs`);

          // Delete the rides themselves
          const ridesDeleted = await tx.ride.deleteMany({
            where: { id: { in: rideIds } },
          });
          console.log(`Deleted ${ridesDeleted.count} rides`);
        }

        // 7. Handle LongDistanceBookings
        const ldBookingsDeleted = await tx.longDistanceBooking.deleteMany({
          where: {
            OR: [{ userId: userId }, { driverId: userId }],
          },
        });
        console.log(
          `Deleted ${ldBookingsDeleted.count} long distance bookings`
        );

        // 8. Handle VendorBookings
        const vbBookingsDeleted = await tx.vendorBooking.deleteMany({
          where: {
            OR: [{ vendorId: userId }, { driverId: userId }],
          },
        });
        console.log(`Deleted ${vbBookingsDeleted.count} vendor bookings`);

        // 9. Delete DriverStatus if user is a driver
        if (user.userType === "DRIVER") {
          const driverStatusDeleted = await tx.driverStatus.deleteMany({
            where: { driverId: userId },
          });
          console.log(
            `Deleted ${driverStatusDeleted.count} driver status records`
          );
        }

        // 10. Delete Wallet
        const walletDeleted = await tx.wallet.deleteMany({
          where: { userId: userId },
        });
        console.log(`Deleted ${walletDeleted.count} wallet records`);

        // 11. Delete type-specific details
        if (user.userType === "DRIVER" && user.driverDetails) {
          const driverDetailsDeleted = await tx.driverDetails.delete({
            where: { id: user.driverDetails.id },
          });
          console.log(`Deleted driver details`);
        }

        if (user.userType === "VENDOR" && user.vendorDetails) {
          const vendorDetailsDeleted = await tx.vendorDetails.delete({
            where: { id: user.vendorDetails.id },
          });
          console.log(`Deleted vendor details`);
        }

        if (user.userType === "USER" && user.userDetails) {
          const userDetailsDeleted = await tx.userDetails.delete({
            where: { id: user.userDetails.id },
          });
          console.log(`Deleted user details`);
        }

        // 12. Finally delete the user record
        const deletedUser = await tx.user.delete({
          where: { id: userId },
        });

        console.log(
          `Successfully deleted user: ${deletedUser.name || "Unnamed"} (${deletedUser.phone})`
        );
      },
      {
        timeout: 30000, // Increase timeout to 30 seconds
      }
    );
  } catch (error) {
    console.error("Error deleting user:", error);

    // If transaction fails, try alternative approach with non-transactional operations
    console.log("Attempting alternative deletion approach...");
    await deleteUserNonTransactional(userId);
  }
}

// Non-transactional fallback function that deletes records in the correct order
async function deleteUserNonTransactional(userId: string): Promise<void> {
  try {
    // Get user details first
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        driverDetails: true,
        vendorDetails: true,
        userDetails: true,
      },
    });

    if (!user) {
      console.error(`User with ID ${userId} not found.`);
      return;
    }

    console.log("Starting non-transactional deletion process...");

    // 1. Get all ride IDs where this user is involved
    const rideIdsToDelete = await prisma.ride.findMany({
      where: {
        OR: [{ userId: userId }, { driverId: userId }],
      },
      select: { id: true },
    });

    const rideIds = rideIdsToDelete.map((ride) => ride.id);

    // 2. Delete chat messages for these rides and from this user
    if (rideIds.length > 0) {
      const rideChatsDeleted = await prisma.chatMessage.deleteMany({
        where: { rideId: { in: rideIds } },
      });
      console.log(`Deleted ${rideChatsDeleted.count} ride chat messages`);
    }

    const userChatsDeleted = await prisma.chatMessage.deleteMany({
      where: { senderId: userId },
    });
    console.log(`Deleted ${userChatsDeleted.count} user chat messages`);

    // 3. Delete ride location logs
    if (rideIds.length > 0) {
      const logsDeleted = await prisma.rideLocationLog.deleteMany({
        where: { rideId: { in: rideIds } },
      });
      console.log(`Deleted ${logsDeleted.count} ride location logs`);
    }

    // 4. Delete all transactions
    const transactionsDeleted = await prisma.transaction.deleteMany({
      where: {
        OR: [{ senderId: userId }, { receiverId: userId }],
      },
    });
    console.log(`Deleted ${transactionsDeleted.count} transactions`);

    // 5. Delete all long distance transactions
    const ldTransactionsDeleted =
      await prisma.longDistanceTransaction.deleteMany({
        where: {
          OR: [{ senderId: userId }, { receiverId: userId }],
        },
      });
    console.log(
      `Deleted ${ldTransactionsDeleted.count} long distance transactions`
    );

    // 6. Delete all vendor booking transactions
    const vbTransactionsDeleted =
      await prisma.vendorBookingTransaction.deleteMany({
        where: {
          OR: [{ senderId: userId }, { receiverId: userId }],
        },
      });
    console.log(
      `Deleted ${vbTransactionsDeleted.count} vendor booking transactions`
    );

    // 7. Delete rides
    if (rideIds.length > 0) {
      const ridesDeleted = await prisma.ride.deleteMany({
        where: { id: { in: rideIds } },
      });
      console.log(`Deleted ${ridesDeleted.count} rides`);
    }

    // 8. Delete long distance bookings
    const ldBookingsDeleted = await prisma.longDistanceBooking.deleteMany({
      where: {
        OR: [{ userId: userId }, { driverId: userId }],
      },
    });
    console.log(`Deleted ${ldBookingsDeleted.count} long distance bookings`);

    // 9. Delete vendor bookings
    const vbBookingsDeleted = await prisma.vendorBooking.deleteMany({
      where: {
        OR: [{ vendorId: userId }, { driverId: userId }],
      },
    });
    console.log(`Deleted ${vbBookingsDeleted.count} vendor bookings`);

    // 10. Delete driver status if applicable
    if (user.userType === "DRIVER") {
      const driverStatusDeleted = await prisma.driverStatus.deleteMany({
        where: { driverId: userId },
      });
      console.log(`Deleted ${driverStatusDeleted.count} driver status records`);
    }

    // 11. Delete wallet
    const walletDeleted = await prisma.wallet.deleteMany({
      where: { userId },
    });
    console.log(`Deleted ${walletDeleted.count} wallet records`);

    // 12. Delete type-specific details
    if (user.userType === "DRIVER" && user.driverDetails) {
      await prisma.driverDetails.delete({
        where: { id: user.driverDetails.id },
      });
      console.log("Deleted driver details");
    }

    if (user.userType === "VENDOR" && user.vendorDetails) {
      await prisma.vendorDetails.delete({
        where: { id: user.vendorDetails.id },
      });
      console.log("Deleted vendor details");
    }

    if (user.userType === "USER" && user.userDetails) {
      await prisma.userDetails.delete({
        where: { id: user.userDetails.id },
      });
      console.log("Deleted user details");
    }

    // 13. Finally delete the user
    const deletedUser = await prisma.user.delete({
      where: { id: userId },
    });

    console.log(
      `Successfully deleted user: ${deletedUser.name || "Unnamed"} (${deletedUser.phone})`
    );
  } catch (error) {
    console.error("Error in non-transactional deletion:", error);
  }
}

function promptForUserId(): Promise<string> {
  return new Promise((resolve) => {
    rl.question("Enter the user ID to delete: ", (userId) => {
      resolve(userId.trim());
    });
  });
}

async function main() {
  console.log("===== User Deletion Tool =====");
  console.log("WARNING: This will delete the user and ALL associated records!");
  console.log("This action cannot be undone.");

  const userId = await promptForUserId();

  rl.question(
    `Are you sure you want to delete user ${userId}? (yes/no): `,
    async (answer) => {
      if (answer.toLowerCase() === "yes") {
        await deleteUser(userId);
      } else {
        console.log("Deletion cancelled.");
      }

      rl.close();
      await prisma.$disconnect();
    }
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
