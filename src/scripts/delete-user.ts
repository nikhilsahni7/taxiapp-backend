import { PrismaClient } from "@prisma/client";

// Create readline interface for command line input
// const rl = readline.createInterface({
// input: process.stdin,
// output: process.stdout,
// });

export async function deleteUserWithPrisma(
  prisma: PrismaClient,
  userId: string
): Promise<{ success: boolean; message: string; error?: any }> {
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
      return { success: false, message: `User with ID ${userId} not found.` };
    }

    console.log(
      `Found user: ${user.name || "Unnamed"} (${user.phone}) - Type: ${user.userType}`
    );

    // Use a longer transaction timeout to prevent "Transaction already closed" errors
    await prisma.$transaction(
      async (tx) => {
        // 1. Get all ride IDs where this user is involved (either as user or driver)
        const rideIdsToDelete = await tx.ride.findMany({
          where: {
            OR: [{ userId: userId }, { driverId: userId }],
          },
          select: { id: true },
        });

        const rideIds = rideIdsToDelete.map((ride) => ride.id);

        // 2. Get all long distance booking IDs where this user is involved
        const ldBookingIdsToDelete = await tx.longDistanceBooking.findMany({
          where: {
            OR: [{ userId: userId }, { driverId: userId }],
          },
          select: { id: true },
        });

        const ldBookingIds = ldBookingIdsToDelete.map((booking) => booking.id);

        // 3. Get all vendor booking IDs where this user is involved
        const vbBookingIdsToDelete = await tx.vendorBooking.findMany({
          where: {
            OR: [{ vendorId: userId }, { driverId: userId }],
          },
          select: { id: true },
        });

        const vbBookingIds = vbBookingIdsToDelete.map((booking) => booking.id);

        // 4. Delete chat messages for rides and sent by user
        if (rideIds.length > 0) {
          const rideChatsDeleted = await tx.chatMessage.deleteMany({
            where: { rideId: { in: rideIds } },
          });
          console.log(`Deleted ${rideChatsDeleted.count} ride chat messages`);
        }

        const chatMessagesDeleted = await tx.chatMessage.deleteMany({
          where: { senderId: userId },
        });
        console.log(`Deleted ${chatMessagesDeleted.count} user chat messages`);

        // 5. Delete ride location logs for rides
        if (rideIds.length > 0) {
          const locationLogsDeleted = await tx.rideLocationLog.deleteMany({
            where: { rideId: { in: rideIds } },
          });
          console.log(
            `Deleted ${locationLogsDeleted.count} ride location logs`
          );
        }

        // 6. Delete all transactions that reference rides
        const transactionsDeleted = await tx.transaction.deleteMany({
          where: {
            OR: [
              { senderId: userId },
              { receiverId: userId },
              ...(rideIds.length > 0 ? [{ rideId: { in: rideIds } }] : []),
            ],
          },
        });
        console.log(`Deleted ${transactionsDeleted.count} transactions`);

        // 7. Delete all long distance transactions that reference bookings or involve user
        const ldTransactionsDeleted =
          await tx.longDistanceTransaction.deleteMany({
            where: {
              OR: [
                { senderId: userId },
                { receiverId: userId },
                ...(ldBookingIds.length > 0
                  ? [{ bookingId: { in: ldBookingIds } }]
                  : []),
              ],
            },
          });
        console.log(
          `Deleted ${ldTransactionsDeleted.count} long distance transactions`
        );

        // 8. Delete all vendor booking transactions that reference bookings or involve user
        const vbTransactionsDeleted =
          await tx.vendorBookingTransaction.deleteMany({
            where: {
              OR: [
                { senderId: userId },
                { receiverId: userId },
                ...(vbBookingIds.length > 0
                  ? [{ bookingId: { in: vbBookingIds } }]
                  : []),
              ],
            },
          });
        console.log(
          `Deleted ${vbTransactionsDeleted.count} vendor booking transactions`
        );

        // 9. Now delete the rides themselves
        if (rideIds.length > 0) {
          const ridesDeleted = await tx.ride.deleteMany({
            where: { id: { in: rideIds } },
          });
          console.log(`Deleted ${ridesDeleted.count} rides`);
        }

        // 10. Now delete the long distance bookings
        if (ldBookingIds.length > 0) {
          const ldBookingsDeleted = await tx.longDistanceBooking.deleteMany({
            where: { id: { in: ldBookingIds } },
          });
          console.log(
            `Deleted ${ldBookingsDeleted.count} long distance bookings`
          );
        }

        // 11. Now delete the vendor bookings
        if (vbBookingIds.length > 0) {
          const vbBookingsDeleted = await tx.vendorBooking.deleteMany({
            where: { id: { in: vbBookingIds } },
          });
          console.log(`Deleted ${vbBookingsDeleted.count} vendor bookings`);
        }

        // 12. Delete DriverStatus if user is a driver
        if (user.userType === "DRIVER") {
          const driverStatusDeleted = await tx.driverStatus.deleteMany({
            where: { driverId: userId },
          });
          console.log(
            `Deleted ${driverStatusDeleted.count} driver status records`
          );
        }

        // 13. Delete Wallet
        const walletDeleted = await tx.wallet.deleteMany({
          where: { userId: userId },
        });
        console.log(`Deleted ${walletDeleted.count} wallet records`);

        // 14. Delete type-specific details
        if (user.userType === "DRIVER" && user.driverDetails) {
          await tx.driverDetails.delete({
            where: { id: user.driverDetails.id },
          });
          console.log(`Deleted driver details`);
        }

        if (user.userType === "VENDOR" && user.vendorDetails) {
          await tx.vendorDetails.delete({
            where: { id: user.vendorDetails.id },
          });
          console.log(`Deleted vendor details`);
        }

        if (user.userType === "USER" && user.userDetails) {
          await tx.userDetails.delete({
            where: { id: user.userDetails.id },
          });
          console.log(`Deleted user details`);
        }

        // 15. Finally delete the user record
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
    return { success: true, message: `Successfully deleted user ${userId}` };
  } catch (error) {
    console.error("Error deleting user:", error);

    // If transaction fails, try alternative approach with non-transactional operations
    console.log("Attempting alternative deletion approach...");
    return await deleteUserNonTransactionalWithPrisma(prisma, userId);
  }
}

// Non-transactional fallback function that deletes records in the correct order
export async function deleteUserNonTransactionalWithPrisma(
  prisma: PrismaClient,
  userId: string
): Promise<{ success: boolean; message: string; error?: any }> {
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
      return { success: false, message: `User with ID ${userId} not found.` };
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

    // 2. Get all long distance booking IDs where this user is involved
    const ldBookingIdsToDelete = await prisma.longDistanceBooking.findMany({
      where: {
        OR: [{ userId: userId }, { driverId: userId }],
      },
      select: { id: true },
    });

    const ldBookingIds = ldBookingIdsToDelete.map((booking) => booking.id);

    // 3. Get all vendor booking IDs where this user is involved
    const vbBookingIdsToDelete = await prisma.vendorBooking.findMany({
      where: {
        OR: [{ vendorId: userId }, { driverId: userId }],
      },
      select: { id: true },
    });

    const vbBookingIds = vbBookingIdsToDelete.map((booking) => booking.id);

    // 4. Delete chat messages for these rides and from this user
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

    // 5. Delete ride location logs
    if (rideIds.length > 0) {
      const logsDeleted = await prisma.rideLocationLog.deleteMany({
        where: { rideId: { in: rideIds } },
      });
      console.log(`Deleted ${logsDeleted.count} ride location logs`);
    }

    // 6. Delete all transactions
    const transactionsDeleted = await prisma.transaction.deleteMany({
      where: {
        OR: [
          { senderId: userId },
          { receiverId: userId },
          ...(rideIds.length > 0 ? [{ rideId: { in: rideIds } }] : []),
        ],
      },
    });
    console.log(`Deleted ${transactionsDeleted.count} transactions`);

    // 7. Delete all long distance transactions
    const ldTransactionsDeleted =
      await prisma.longDistanceTransaction.deleteMany({
        where: {
          OR: [
            { senderId: userId },
            { receiverId: userId },
            ...(ldBookingIds.length > 0
              ? [{ bookingId: { in: ldBookingIds } }]
              : []),
          ],
        },
      });
    console.log(
      `Deleted ${ldTransactionsDeleted.count} long distance transactions`
    );

    // 8. Delete all vendor booking transactions
    const vbTransactionsDeleted =
      await prisma.vendorBookingTransaction.deleteMany({
        where: {
          OR: [
            { senderId: userId },
            { receiverId: userId },
            ...(vbBookingIds.length > 0
              ? [{ bookingId: { in: vbBookingIds } }]
              : []),
          ],
        },
      });
    console.log(
      `Deleted ${vbTransactionsDeleted.count} vendor booking transactions`
    );

    // 9. Delete rides
    if (rideIds.length > 0) {
      const ridesDeleted = await prisma.ride.deleteMany({
        where: { id: { in: rideIds } },
      });
      console.log(`Deleted ${ridesDeleted.count} rides`);
    }

    // 10. Delete long distance bookings
    if (ldBookingIds.length > 0) {
      const ldBookingsDeleted = await prisma.longDistanceBooking.deleteMany({
        where: { id: { in: ldBookingIds } },
      });
      console.log(`Deleted ${ldBookingsDeleted.count} long distance bookings`);
    }

    // 11. Delete vendor bookings
    if (vbBookingIds.length > 0) {
      const vbBookingsDeleted = await prisma.vendorBooking.deleteMany({
        where: { id: { in: vbBookingIds } },
      });
      console.log(`Deleted ${vbBookingsDeleted.count} vendor bookings`);
    }

    // 12. Delete driver status if applicable
    if (user.userType === "DRIVER") {
      const driverStatusDeleted = await prisma.driverStatus.deleteMany({
        where: { driverId: userId },
      });
      console.log(`Deleted ${driverStatusDeleted.count} driver status records`);
    }

    // 13. Delete wallet
    const walletDeleted = await prisma.wallet.deleteMany({
      where: { userId },
    });
    console.log(`Deleted ${walletDeleted.count} wallet records`);

    // 14. Delete type-specific details
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

    // 15. Finally delete the user
    const deletedUser = await prisma.user.delete({
      where: { id: userId },
    });

    console.log(
      `Successfully deleted user: ${deletedUser.name || "Unnamed"} (${deletedUser.phone})`
    );
    return {
      success: true,
      message: `Successfully deleted user ${userId} (non-transactional)`,
    };
  } catch (error) {
    console.error("Error in non-transactional deletion:", error);
    return {
      success: false,
      message: `Error deleting user ${userId} (non-transactional)`,
      error,
    };
  }
}

// function promptForUserId(): Promise<string> {
//   return new Promise((resolve) => {
//     rl.question("Enter the user ID to delete: ", (userId) => {
//       resolve(userId.trim());
//     });
//   });
// }

// async function main() {
//   const prisma = new PrismaClient();
//   console.log("===== User Deletion Tool ======");
//   console.log("WARNING: This will delete the user and ALL associated records!");
//   console.log("This action cannot be undone.");

//   const userId = await promptForUserId();

//   rl.question(
//     `Are you sure you want to delete user ${userId}? (yes/no): `,
//     async (answer) => {
//       if (answer.toLowerCase() === "yes") {
//         await deleteUserWithPrisma(prisma, userId);
//       } else {
//         console.log("Deletion cancelled.");
//       }

//       rl.close();
//       await prisma.$disconnect();
//     }
//   );
// }

// main().catch((e) => {
//   console.error(e);
//   process.exit(1);
// });
