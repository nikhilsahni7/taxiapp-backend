import type { Request, Response } from "express";
import { PrismaClient, TransactionStatus } from "@prisma/client";

const prisma = new PrismaClient();
export const getAllRidesData = async (req: Request, res: Response) => {
  try {
    const [
      localRides,
      longDistanceBookings,
      vendorBookings,
      activeLocalRides,
      activeLongDistanceBookings,
      activeVendorBookings,
    ] = await Promise.all([
      // All local rides with user and driver details
      prisma.ride.findMany({
        include: {
          user: {
            include: {
              userDetails: true,
              wallet: true,
            },
          },
          driver: {
            include: {
              driverDetails: true,
              driverStatus: true,
              wallet: true,
            },
          },
          transactions: true,
        },
        orderBy: {
          createdAt: "desc",
        },
      }),
      // All long distance bookings
      prisma.longDistanceBooking.findMany({
        include: {
          user: {
            include: {
              userDetails: true,
              wallet: true,
            },
          },
          driver: {
            include: {
              driverDetails: true,
              driverStatus: true,
              wallet: true,
            },
          },
          transactions: true,
        },
        orderBy: {
          createdAt: "desc",
        },
      }),
      // All vendor bookings
      prisma.vendorBooking.findMany({
        include: {
          vendor: {
            include: {
              vendorDetails: true,
              wallet: true,
            },
          },
          driver: {
            include: {
              driverDetails: true,
              driverStatus: true,
              wallet: true,
            },
          },
          transactions: true,
        },
        orderBy: {
          createdAt: "desc",
        },
      }),
      // Active local rides
      prisma.ride.findMany({
        where: {
          status: {
            notIn: ["PAYMENT_COMPLETED", "RIDE_ENDED", "CANCELLED"],
          },
        },
        include: {
          user: {
            include: {
              userDetails: true,
              wallet: true,
            },
          },
          driver: {
            include: {
              driverDetails: true,
              driverStatus: true,
              wallet: true,
            },
          },
          transactions: true,
        },
        orderBy: {
          createdAt: "desc",
        },
      }),
      // Active long distance bookings
      prisma.longDistanceBooking.findMany({
        where: {
          status: {
            notIn: ["COMPLETED", "CANCELLED"],
          },
        },
        include: {
          user: {
            include: {
              userDetails: true,
              wallet: true,
            },
          },
          driver: {
            include: {
              driverDetails: true,
              driverStatus: true,
              wallet: true,
            },
          },
          transactions: true,
        },
        orderBy: {
          createdAt: "desc",
        },
      }),
      // Active vendor bookings
      prisma.vendorBooking.findMany({
        where: {
          status: {
            notIn: ["COMPLETED"],
          },
        },
        include: {
          vendor: {
            include: {
              vendorDetails: true,
              wallet: true,
            },
          },
          driver: {
            include: {
              driverDetails: true,
              driverStatus: true,
              wallet: true,
            },
          },
          transactions: true,
        },
        orderBy: {
          createdAt: "desc",
        },
      }),
    ]);

    res.json({
      allRides: {
        localRides,
        longDistanceBookings,
        vendorBookings,
      },
      activeRides: {
        localRides: activeLocalRides,
        longDistanceBookings: activeLongDistanceBookings,
        vendorBookings: activeVendorBookings,
      },
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch rides data" });
  }
};

// Get detailed statistics for all service types
export const getDetailedStats = async (req: Request, res: Response) => {
  try {
    // Test database connection first
    try {
      await prisma.$connect();
    } catch (connectionError) {
      console.error("Database connection failed:", connectionError);
      return res.status(503).json({
        error: "Database connection failed",
        details: "Unable to connect to the database server",
      });
    }

    const [
      longDistanceStats,
      userStats,
      driverStats,
      vendorStats,
      walletStats,
      transactionStats,
      rideStats,
    ] = await Promise.all([
      // Long distance service type stats
      prisma.longDistanceBooking.groupBy({
        by: ["serviceType", "status", "tripType"],
        _count: true,
        _sum: {
          totalAmount: true,
          advanceAmount: true,
          remainingAmount: true,
          commission: true,
        },
      }),
      // User stats
      prisma.user.findMany({
        where: { userType: "USER" },
        include: {
          userDetails: true,
          wallet: true,
          ridesAsUser: {
            include: {
              transactions: true,
            },
          },
          longDistanceBookingsAsUser: {
            include: {
              transactions: true,
            },
          },
        },
      }),
      // Driver stats
      prisma.user.findMany({
        where: { userType: "DRIVER" },
        include: {
          driverDetails: true,
          wallet: true,
          driverStatus: true,
          ridesAsDriver: {
            include: {
              transactions: true,
            },
          },
          longDistanceBookingsAsDriver: {
            include: {
              transactions: true,
            },
          },
          driverVendorBookings: {
            include: {
              transactions: true,
            },
          },
        },
      }),
      // Vendor stats
      prisma.user.findMany({
        where: { userType: "VENDOR" },
        include: {
          vendorDetails: true,
          wallet: true,
          vendorBookings: {
            include: {
              transactions: true,
              driver: true,
            },
          },
        },
      }),
      // Wallet stats
      prisma.wallet.findMany({
        include: {
          user: {
            include: {
              userDetails: true,
              driverDetails: true,
              vendorDetails: true,
            },
          },
        },
      }),
      // Transaction stats for all types
      Promise.all([
        prisma.transaction.groupBy({
          by: ["status", "type"],
          _count: true,
          _sum: {
            amount: true,
          },
        }),
        prisma.longDistanceTransaction.groupBy({
          by: ["status", "type"],
          _count: true,
          _sum: {
            amount: true,
          },
        }),
        prisma.vendorBookingTransaction.groupBy({
          by: ["status", "type"],
          _count: true,
          _sum: {
            amount: true,
          },
        }),
      ]),
      // Ride type stats
      prisma.ride.groupBy({
        by: ["rideType", "status", "outstationType"],
        _count: true,
        _sum: {
          totalAmount: true,
          fare: true,
          tax: true,
          extraCharges: true,
        },
      }),
    ]).catch((queryError) => {
      console.error("Query execution failed:", queryError);
      throw new Error("Failed to execute database queries");
    });

    res.json({
      longDistanceStats,
      userStats: {
        total: userStats.length,
        users: userStats,
      },
      driverStats: {
        total: driverStats.length,
        activeDrivers: driverStats.filter((d) => d.driverStatus?.isOnline),
        drivers: driverStats,
      },
      vendorStats: {
        total: vendorStats.length,
        vendors: vendorStats,
      },
      walletStats: {
        totalBalance: walletStats.reduce((sum, w) => sum + w.balance, 0),
        wallets: walletStats,
      },
      transactionStats: {
        rides: transactionStats[0],
        longDistance: transactionStats[1],
        vendor: transactionStats[2],
      },
      rideStats: rideStats,
    });
  } catch (error) {
    console.error("Error in getDetailedStats:", error);
    const errorMessage =
      error instanceof Error
        ? error.message
        : "Failed to fetch detailed statistics";
    res.status(500).json({
      error: errorMessage,
      timestamp: new Date().toISOString(),
    });
  } finally {
    // Disconnect explicitly to clean up
    await prisma.$disconnect();
  }
};

export const getPendingWithdrawals = async (req: Request, res: Response) => {
  try {
    const withdrawals = await prisma.transaction.findMany({
      where: {
        type: "WITHDRAWAL",
        status: "PENDING",
      },
      include: {
        sender: true,
      },
    });

    res.json(withdrawals);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch withdrawals" });
  }
};

// Handle withdrawal approval/rejection
export const handleWithdrawal = async (req: Request, res: Response) => {
  try {
    const { transactionId } = req.params;
    const { action, reason } = req.body;

    const transaction = await prisma.$transaction(async (prisma) => {
      const withdrawal = await prisma.transaction.findUnique({
        where: { id: transactionId },
        include: { sender: true },
      });

      if (!withdrawal) {
        throw new Error("Withdrawal not found");
      }

      if (action === "APPROVE") {
        return await prisma.transaction.update({
          where: { id: transactionId },
          data: { status: TransactionStatus.COMPLETED },
        });
      } else {
        // Reject: Refund the amount
        const updated = await prisma.transaction.update({
          where: { id: transactionId },
          data: {
            status: TransactionStatus.FAILED,
            metadata: {
              ...((withdrawal.metadata as object) || {}),
              rejectionReason: reason,
            },
          },
        });

        // Refund to wallet
        await prisma.wallet.update({
          where: { userId: withdrawal.senderId! },
          data: {
            balance: { increment: withdrawal.amount },
          },
        });

        return updated;
      }
    });

    res.json({
      success: true,
      transaction,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to process withdrawal" });
  }
};
