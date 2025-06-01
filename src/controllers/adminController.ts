import { PrismaClient, TransactionStatus } from "@prisma/client";
import type { Request, Response } from "express";

const prisma = new PrismaClient();
export const getAllRidesData = async (
  req: Request,
  res: Response
): Promise<void> => {
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
export const getDetailedStats = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    // Test database connection first
    try {
      await prisma.$connect();
    } catch (connectionError) {
      console.error("Database connection failed:", connectionError);
      res.status(503).json({
        error: "Database connection failed",
        details: "Unable to connect to the database server",
      });
      return;
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
        by: ["rideType", "status"],
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

export const getPendingWithdrawals = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const withdrawals = await prisma.transaction.findMany({
      where: {
        type: "WITHDRAWAL",
        status: "PENDING",
      },
      include: {
        sender: {
          include: {
            wallet: true,
          },
        },
      },
    });

    res.json(withdrawals);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch withdrawals" });
  }
};

// Handle withdrawal approval/rejection
export const handleWithdrawal = async (
  req: Request,
  res: Response
): Promise<void> => {
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
        // First update the transaction status
        const updatedTransaction = await prisma.transaction.update({
          where: { id: transactionId },
          data: { status: TransactionStatus.COMPLETED },
        });

        // Then reduce the wallet balance
        await prisma.wallet.update({
          where: { userId: withdrawal.senderId! },
          data: {
            balance: { decrement: withdrawal.amount },
          },
        });

        return updatedTransaction;
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

// / Get active rides status for local rides
export const getActiveLocalRidesStatus = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const activeLocalRides = await prisma.ride.findMany({
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
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    res.json({
      totalActiveRides: activeLocalRides.length,
      activeRides: activeLocalRides.map((ride) => ({
        id: ride.id,
        status: ride.status,
        user: ride.user,
        driver: ride.driver,
        pickupLocation: ride.pickupLocation,
        dropLocation: ride.dropLocation,
        rideType: ride.rideType,
        createdAt: ride.createdAt,
        driverAcceptedAt: ride.driverAcceptedAt,
        rideStartedAt: ride.waitStartTime,
      })),
    });
  } catch (error) {
    res
      .status(500)
      .json({ error: "Failed to fetch active local rides status" });
  }
};

// Get active rides status for long distance rides
export const getActiveLongDistanceRidesStatus = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const activeLongDistanceRides = await prisma.longDistanceBooking.findMany({
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
            wallet: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    res.json({
      totalActiveRides: activeLongDistanceRides.length,
      activeRides: activeLongDistanceRides.map((ride) => ({
        id: ride.id,
        status: ride.status,
        serviceType: ride.serviceType,
        user: ride.user,
        driver: ride.driver,
        pickupLocation: ride.pickupLocation,
        dropLocation: ride.dropLocation,
        tripType: ride.tripType,
        createdAt: ride.createdAt,
        driverAcceptedAt: ride.driverAcceptedAt,
        rideStartedAt: ride.rideStartedAt,
        driverArrivedAt: ride.driverArrivedAt,
        advancePaidAt: ride.advancePaidAt,
      })),
    });
  } catch (error) {
    res
      .status(500)
      .json({ error: "Failed to fetch active long distance rides status" });
  }
};

// Get active rides status for vendor bookings
export const getActiveVendorRidesStatus = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const activeVendorRides = await prisma.vendorBooking.findMany({
      where: {
        status: {
          notIn: ["COMPLETED"],
        },
      },
      include: {
        vendor: {
          include: {
            vendorDetails: true,
          },
        },
        driver: {
          include: {
            driverDetails: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    res.json({
      totalActiveRides: activeVendorRides.length,
      activeRides: activeVendorRides.map((ride) => ({
        id: ride.id,
        status: ride.status,
        serviceType: ride.serviceType,
        vendor: ride.vendor,
        driver: ride.driver,
        pickupLocation: ride.pickupLocation,
        dropLocation: ride.dropLocation,
        tripType: ride.tripType,
        createdAt: ride.createdAt,
        driverAcceptedAt: ride.driverAcceptedAt,
        rideStartedAt: ride.rideStartedAt,
        driverCommissionPaid: ride.driverCommissionPaid,
        vendorPaidAt: ride.vendorPaidAt,
      })),
    });
  } catch (error) {
    res
      .status(500)
      .json({ error: "Failed to fetch active vendor rides status" });
  }
};

// Get all transactions for a specific user/driver/vendor
export const getUserTransactions = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const { userId } = req.params;

    const [
      regularTransactions,
      longDistanceTransactions,
      vendorTransactions,
      wallet,
    ] = await Promise.all([
      // Regular ride transactions
      prisma.transaction.findMany({
        where: {
          OR: [{ senderId: userId }, { receiverId: userId }],
        },
        include: {
          ride: true,
          sender: true,
          receiver: true,
        },
        orderBy: { createdAt: "desc" },
      }),

      // Long distance transactions
      prisma.longDistanceTransaction.findMany({
        where: {
          OR: [{ senderId: userId }, { receiverId: userId }],
        },
        include: {
          booking: true,
          sender: true,
          receiver: true,
        },
        orderBy: { createdAt: "desc" },
      }),

      // Vendor transactions
      prisma.vendorBookingTransaction.findMany({
        where: {
          OR: [{ senderId: userId }, { receiverId: userId }],
        },
        include: {
          booking: true,
          sender: true,
          receiver: true,
        },
        orderBy: { createdAt: "desc" },
      }),

      // Get wallet details
      prisma.wallet.findUnique({
        where: { userId },
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
    ]);

    res.json({
      wallet,
      transactions: {
        regular: regularTransactions,
        longDistance: longDistanceTransactions,
        vendor: vendorTransactions,
      },
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch user transactions" });
  }
};

// Adjust wallet balance
export const adjustWalletBalance = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const { userId } = req.params;
    const { amount, action, reason } = req.body;

    if (!amount || !action || amount <= 0) {
      res.status(400).json({
        error:
          "Invalid input. Amount must be positive and action must be specified",
      });
      return;
    }

    const result = await prisma.$transaction(async (prisma) => {
      // Check if wallet exists for this user
      const existingWallet = await prisma.wallet.findUnique({
        where: { userId },
      });

      let wallet;

      if (existingWallet) {
        // Update existing wallet balance
        wallet = await prisma.wallet.update({
          where: { userId },
          data: {
            balance:
              action === "ADD" ? { increment: amount } : { decrement: amount },
          },
        });
      } else {
        // Create new wallet with initial balance
        wallet = await prisma.wallet.create({
          data: {
            userId,
            balance: action === "ADD" ? amount : 0, // If deducting, start at 0
            currency: "INR",
          },
        });
      }

      // Create transaction record
      const transaction = await prisma.transaction.create({
        data: {
          amount,
          type: "WALLET_TOPUP",
          status: TransactionStatus.COMPLETED,
          senderId: action === "ADD" ? null : userId,
          receiverId: action === "ADD" ? userId : null,
          description:
            reason ||
            `Admin ${action === "ADD" ? "added" : "deducted"} wallet balance`,
          metadata: {
            adjustedBy: "ADMIN",
            reason,
            action,
            timestamp: new Date().toISOString(),
            walletCreated: existingWallet ? false : true,
          },
        },
      });

      return { wallet, transaction };
    });

    res.json({
      success: true,
      message: `Wallet balance ${
        action === "ADD" ? "increased" : "decreased"
      } successfully`,
      ...result,
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to adjust wallet balance",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

// Get wallet summary for all users
export const getAllWalletsSummary = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const wallets = await prisma.wallet.findMany({
      include: {
        user: {
          include: {
            userDetails: true,
            driverDetails: true,
            vendorDetails: true,
          },
        },
      },
    });

    const summary = {
      totalWallets: wallets.length,
      totalBalance: wallets.reduce((sum, w) => sum + w.balance, 0),
      byUserType: {
        users: wallets.filter((w) => w.user.userType === "USER"),
        drivers: wallets.filter((w) => w.user.userType === "DRIVER"),
        vendors: wallets.filter((w) => w.user.userType === "VENDOR"),
      },
    };

    res.json(summary);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch wallets summary" });
  }
};

// Get all user IDs with basic info
export const getAllUsers = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        userType: true,
        verified: true,
        wallet: {
          select: {
            balance: true,
          },
        },
        userDetails: true,
        driverDetails: {
          select: {
            vehicleNumber: true,
            vehicleName: true,
            vehicleCategory: true,
          },
        },
        vendorDetails: {
          select: {
            businessName: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    res.json({
      total: users.length,
      users: users.map((user) => ({
        ...user,
        // Add a display name based on user type
        displayName:
          user.userType === "VENDOR"
            ? user.vendorDetails?.businessName
            : user.name,
      })),
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to fetch users",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

// Get all drivers with details for approval
export const getAllDriversForApproval = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const drivers = await prisma.user.findMany({
      where: {
        userType: "DRIVER",
      },
      include: {
        driverDetails: true,
        wallet: true,
      },
    });

    res.json({
      total: drivers.length,
      pendingApproval: drivers.filter(
        (d) => d.driverDetails && !d.driverDetails.approved
      ).length,
      drivers: drivers.map((driver) => ({
        id: driver.id,
        name: driver.name,
        phone: driver.phone,
        email: driver.email,
        verified: driver.verified,
        createdAt: driver.createdAt,
        approved: driver.driverDetails?.approved || false,
        approvedAt: driver.driverDetails?.approvedAt,
        details: driver.driverDetails,
        wallet: driver.wallet,
      })),
    });
  } catch (error) {
    console.error("Error fetching drivers for approval:", error);
    res.status(500).json({
      error: "Failed to fetch drivers",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

// Get specific driver with all details for approval review
export const getDriverForApproval = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const { driverId } = req.params;

    const driver = await prisma.user.findUnique({
      where: {
        id: driverId,
        userType: "DRIVER",
      },
      include: {
        driverDetails: true,
        wallet: true,
      },
    });

    if (!driver) {
      res.status(404).json({ error: "Driver not found" });
      return;
    }

    res.json({
      id: driver.id,
      name: driver.name,
      phone: driver.phone,
      email: driver.email,
      verified: driver.verified,
      createdAt: driver.createdAt,
      approved: driver.driverDetails?.approved || false,
      approvedAt: driver.driverDetails?.approvedAt,
      details: driver.driverDetails,
      wallet: driver.wallet,
    });
  } catch (error) {
    console.error("Error fetching driver for approval:", error);
    res.status(500).json({
      error: "Failed to fetch driver details",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

// Approve or disapprove a driver
export const updateDriverApproval = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const { driverId } = req.params;
    const { approved, notes } = req.body;

    if (typeof approved !== "boolean") {
      res.status(400).json({
        error: "Invalid input",
        details: "The 'approved' field must be a boolean value",
      });
      return;
    }

    const driver = await prisma.user.findUnique({
      where: {
        id: driverId,
        userType: "DRIVER",
      },
      include: {
        driverDetails: true,
      },
    });

    if (!driver || !driver.driverDetails) {
      res.status(404).json({ error: "Driver not found" });
      return;
    }

    // Update the driver approval status
    const updatedDriverDetails = await prisma.driverDetails.update({
      where: {
        userId: driverId,
      },
      data: {
        approved,
        approvedAt: approved ? new Date() : null,
      },
    });

    res.json({
      success: true,
      message: approved
        ? "Driver approved successfully"
        : "Driver approval revoked",
      driverDetails: updatedDriverDetails,
    });
  } catch (error) {
    console.error("Error updating driver approval:", error);
    res.status(500).json({
      error: "Failed to update driver approval status",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

// Search and get rides across all services with filters
export const searchRidesAcrossServices = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const {
      bookingId,
      driverName,
      customerName,
      pickupLocation,
      dropLocation,
      status,
      serviceType,
      fromDate,
      toDate,
      page = 1,
      limit = 10,
    } = req.query;

    const skip = (Number(page) - 1) * Number(limit);
    const take = Number(limit);

    // Build filter conditions
    const dateFilter: any = {};
    if (fromDate && toDate) {
      dateFilter.createdAt = {
        gte: new Date(fromDate as string),
        lte: new Date(toDate as string),
      };
    }

    // Prepare ride filters
    const rideFilter: any = { ...dateFilter };
    if (bookingId)
      rideFilter.id = { contains: bookingId as string, mode: "insensitive" };
    if (pickupLocation)
      rideFilter.pickupLocation = {
        contains: pickupLocation as string,
        mode: "insensitive",
      };
    if (dropLocation)
      rideFilter.dropLocation = {
        contains: dropLocation as string,
        mode: "insensitive",
      };
    if (status) {
      if (Array.isArray(status)) {
        rideFilter.status = { in: status };
      } else {
        rideFilter.status = status as string;
      }
    }

    // Include active rides first
    const activeRideFilter = {
      ...rideFilter,
      status: {
        notIn: ["PAYMENT_COMPLETED", "RIDE_ENDED", "CANCELLED"],
      },
    };

    // Define service type categories
    const rideServiceTypes = ["LOCAL", "CAR_RENTAL", "OUTSTATION"];
    const longDistanceServiceTypes = [
      "OUTSTATION",
      "HILL_STATION",
      "CHARDHAM_YATRA",
      "ALL_INDIA_TOUR",
    ];
    const vendorServiceTypes = [
      "OUTSTATION",
      "HILL_STATION",
      "CHARDHAM_YATRA",
      "ALL_INDIA_TOUR",
    ];

    // Build filters for different service types
    const longDistanceFilter: any = { ...dateFilter };
    if (bookingId)
      longDistanceFilter.id = {
        contains: bookingId as string,
        mode: "insensitive",
      };
    if (pickupLocation)
      longDistanceFilter.pickupLocation = {
        contains: pickupLocation as string,
        mode: "insensitive",
      };
    if (dropLocation)
      longDistanceFilter.dropLocation = {
        contains: dropLocation as string,
        mode: "insensitive",
      };
    // Apply serviceType filter only if it's a valid LongDistanceServiceType
    if (
      serviceType &&
      longDistanceServiceTypes.includes(serviceType as string)
    ) {
      longDistanceFilter.serviceType = serviceType as string;
    }
    if (status) {
      if (Array.isArray(status)) {
        longDistanceFilter.status = { in: status };
      } else {
        longDistanceFilter.status = status as string;
      }
    }

    const activeLongDistanceFilter = {
      ...longDistanceFilter,
      status: {
        notIn: ["COMPLETED", "CANCELLED"],
      },
    };

    const vendorFilter: any = { ...dateFilter };
    if (bookingId)
      vendorFilter.id = { contains: bookingId as string, mode: "insensitive" };
    if (pickupLocation)
      vendorFilter.pickupLocation = {
        contains: pickupLocation as string,
        mode: "insensitive",
      };
    if (dropLocation)
      vendorFilter.dropLocation = {
        contains: dropLocation as string,
        mode: "insensitive",
      };
    // Apply serviceType filter only if it's a valid LongDistanceServiceType for vendors
    if (serviceType && vendorServiceTypes.includes(serviceType as string)) {
      vendorFilter.serviceType = serviceType as string;
    }
    if (status) {
      if (Array.isArray(status)) {
        vendorFilter.status = { in: status };
      } else {
        vendorFilter.status = status as string;
      }
    }

    const activeVendorFilter = {
      ...vendorFilter,
      status: {
        notIn: ["COMPLETED"],
      },
    };

    // User name filters
    let userFilter = {};
    if (customerName) {
      userFilter = {
        OR: [
          { name: { contains: customerName as string, mode: "insensitive" } },
          { phone: { contains: customerName as string } },
          { email: { contains: customerName as string, mode: "insensitive" } },
        ],
      };
    }

    let driverFilter = {};
    if (driverName) {
      driverFilter = {
        OR: [
          { name: { contains: driverName as string, mode: "insensitive" } },
          { phone: { contains: driverName as string } },
          { email: { contains: driverName as string, mode: "insensitive" } },
        ],
      };
    }

    // Determine if we should include specific ride types based on serviceType
    const shouldIncludeLocalRides =
      !serviceType ||
      (serviceType as string) === "LOCAL" ||
      (serviceType as string) === "CAR_RENTAL" ||
      (serviceType as string) === "OUTSTATION";

    const shouldIncludeLongDistanceRides =
      !serviceType || longDistanceServiceTypes.includes(serviceType as string);

    const shouldIncludeVendorRides =
      !serviceType || vendorServiceTypes.includes(serviceType as string);

    // Prepare local ride type/car rental filters
    let localRideTypeFilter = {};
    let isCarRentalFilter = {};
    if ((serviceType as string) === "LOCAL") {
      localRideTypeFilter = { rideType: "LOCAL" };
      isCarRentalFilter = { isCarRental: false };
    } else if ((serviceType as string) === "OUTSTATION") {
      localRideTypeFilter = { rideType: "OUTSTATION" };
      isCarRentalFilter = { isCarRental: false };
    } else if ((serviceType as string) === "CAR_RENTAL") {
      isCarRentalFilter = { isCarRental: true };
    }

    // Arrays to store our promises and results
    const promises: Promise<any>[] = [];
    const countPromises: Promise<number>[] = [];

    // Only include local rides if relevant
    if (shouldIncludeLocalRides) {
      // Active local rides
      promises.push(
        prisma.ride.findMany({
          where: {
            ...activeRideFilter,
            ...localRideTypeFilter,
            ...isCarRentalFilter,
            user: customerName ? userFilter : {},
            driver: driverName ? driverFilter : {},
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
          skip,
          take,
        })
      );

      // Completed/cancelled local rides
      promises.push(
        prisma.ride.findMany({
          where: {
            ...rideFilter,
            ...localRideTypeFilter,
            ...isCarRentalFilter,
            status: {
              in: ["PAYMENT_COMPLETED", "RIDE_ENDED", "CANCELLED"],
            },
            user: customerName ? userFilter : {},
            driver: driverName ? driverFilter : {},
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
          skip,
          take,
        })
      );

      // Count for pagination - local rides
      countPromises.push(
        prisma.ride.count({
          where: {
            ...rideFilter,
            ...localRideTypeFilter,
            ...isCarRentalFilter,
            user: customerName ? userFilter : {},
            driver: driverName ? driverFilter : {},
          },
        })
      );
    } else {
      // Push empty arrays if we're not including local rides
      promises.push(Promise.resolve([]));
      promises.push(Promise.resolve([]));
      countPromises.push(Promise.resolve(0));
    }

    // Only include long distance rides if relevant
    if (shouldIncludeLongDistanceRides) {
      // Active long distance bookings
      promises.push(
        prisma.longDistanceBooking.findMany({
          where: {
            ...activeLongDistanceFilter,
            user: customerName ? userFilter : {},
            driver: driverName ? driverFilter : {},
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
          skip,
          take,
        })
      );

      // Completed/cancelled long distance bookings
      promises.push(
        prisma.longDistanceBooking.findMany({
          where: {
            ...longDistanceFilter,
            status: {
              in: ["COMPLETED", "CANCELLED"],
            },
            user: customerName ? userFilter : {},
            driver: driverName ? driverFilter : {},
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
          skip,
          take,
        })
      );

      // Count for pagination - long distance bookings
      countPromises.push(
        prisma.longDistanceBooking.count({
          where: {
            ...longDistanceFilter,
            user: customerName ? userFilter : {},
            driver: driverName ? driverFilter : {},
          },
        })
      );
    } else {
      // Push empty arrays if we're not including long distance rides
      promises.push(Promise.resolve([]));
      promises.push(Promise.resolve([]));
      countPromises.push(Promise.resolve(0));
    }

    // Only include vendor rides if relevant
    if (shouldIncludeVendorRides) {
      // Active vendor bookings
      promises.push(
        prisma.vendorBooking.findMany({
          where: {
            ...activeVendorFilter,
            vendor: customerName ? userFilter : {},
            driver: driverName ? driverFilter : {},
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
          skip,
          take,
        })
      );

      // Completed vendor bookings
      promises.push(
        prisma.vendorBooking.findMany({
          where: {
            ...vendorFilter,
            status: "COMPLETED",
            vendor: customerName ? userFilter : {},
            driver: driverName ? driverFilter : {},
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
          skip,
          take,
        })
      );

      // Count for pagination - vendor bookings
      countPromises.push(
        prisma.vendorBooking.count({
          where: {
            ...vendorFilter,
            vendor: customerName ? userFilter : {},
            driver: driverName ? driverFilter : {},
          },
        })
      );
    } else {
      // Push empty arrays if we're not including vendor rides
      promises.push(Promise.resolve([]));
      promises.push(Promise.resolve([]));
      countPromises.push(Promise.resolve(0));
    }

    // Execute all queries
    const results = await Promise.all([...promises, ...countPromises]);

    // Extract results in the right order
    const activeLocalRides = results[0] as any[];
    const localRides = results[1] as any[];
    const activeLongDistanceBookings = results[2] as any[];
    const longDistanceBookings = results[3] as any[];
    const activeVendorBookings = results[4] as any[];
    const vendorBookings = results[5] as any[];
    const totalLocalRides = results[6] as number;
    const totalLongDistanceBookings = results[7] as number;
    const totalVendorBookings = results[8] as number;

    // Format local rides to include service type
    const formattedLocalRides = localRides.map((ride: any) => ({
      ...ride,
      serviceType: ride.isCarRental ? "CAR_RENTAL" : ride.rideType,
      pickupTime: null, // Convert to consistent format with other booking types
      bookingType: "LOCAL_RIDE",
    }));

    const formattedActiveLocalRides = activeLocalRides.map((ride: any) => ({
      ...ride,
      serviceType: ride.isCarRental ? "CAR_RENTAL" : ride.rideType,
      pickupTime: null,
      bookingType: "LOCAL_RIDE",
    }));

    // Format long distance bookings
    const formattedLongDistanceBookings = longDistanceBookings.map(
      (booking: any) => ({
        ...booking,
        bookingType: "LONG_DISTANCE",
      })
    );

    const formattedActiveLongDistanceBookings = activeLongDistanceBookings.map(
      (booking: any) => ({
        ...booking,
        bookingType: "LONG_DISTANCE",
      })
    );

    // Format vendor bookings
    const formattedVendorBookings = vendorBookings.map((booking: any) => ({
      ...booking,
      bookingType: "VENDOR_BOOKING",
    }));

    const formattedActiveVendorBookings = activeVendorBookings.map(
      (booking: any) => ({
        ...booking,
        bookingType: "VENDOR_BOOKING",
      })
    );

    // Combine all results
    const activeRides = [
      ...formattedActiveLocalRides,
      ...formattedActiveLongDistanceBookings,
      ...formattedActiveVendorBookings,
    ];

    const completedRides = [
      ...formattedLocalRides,
      ...formattedLongDistanceBookings,
      ...formattedVendorBookings,
    ];

    // Sort all results by creation date, active rides first
    const allResults = [
      ...activeRides.sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      ),
      ...completedRides.sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      ),
    ];

    // Calculate totals for pagination
    const totalResults =
      totalLocalRides + totalLongDistanceBookings + totalVendorBookings;
    const totalPages = Math.ceil(totalResults / Number(limit));

    // Return response with pagination
    res.json({
      rides: allResults,
      pagination: {
        totalResults,
        totalPages,
        currentPage: Number(page),
        limit: Number(limit),
      },
      summary: {
        totalLocalRides,
        totalLongDistanceBookings,
        totalVendorBookings,
        activeRidesCount: activeRides.length,
        completedRidesCount: completedRides.length,
        serviceDistribution: {
          local: formattedLocalRides
            .concat(formattedActiveLocalRides)
            .filter((r) => r.serviceType === "LOCAL").length,
          outstation: [
            ...formattedLocalRides
              .concat(formattedActiveLocalRides)
              .filter((r) => r.serviceType === "OUTSTATION"),
            ...formattedLongDistanceBookings
              .concat(formattedActiveLongDistanceBookings)
              .filter((r) => r.serviceType === "OUTSTATION"),
            ...formattedVendorBookings
              .concat(formattedActiveVendorBookings)
              .filter((r) => r.serviceType === "OUTSTATION"),
          ].length,
          carRental: formattedLocalRides
            .concat(formattedActiveLocalRides)
            .filter((r) => r.serviceType === "CAR_RENTAL").length,
          hillStation: [
            ...formattedLongDistanceBookings
              .concat(formattedActiveLongDistanceBookings)
              .filter((r) => r.serviceType === "HILL_STATION"),
            ...formattedVendorBookings
              .concat(formattedActiveVendorBookings)
              .filter((r) => r.serviceType === "HILL_STATION"),
          ].length,
          chardham: [
            ...formattedLongDistanceBookings
              .concat(formattedActiveLongDistanceBookings)
              .filter((r) => r.serviceType === "CHARDHAM_YATRA"),
            ...formattedVendorBookings
              .concat(formattedActiveVendorBookings)
              .filter((r) => r.serviceType === "CHARDHAM_YATRA"),
          ].length,
          allIndia: [
            ...formattedLongDistanceBookings
              .concat(formattedActiveLongDistanceBookings)
              .filter((r) => r.serviceType === "ALL_INDIA_TOUR"),
            ...formattedVendorBookings
              .concat(formattedActiveVendorBookings)
              .filter((r) => r.serviceType === "ALL_INDIA_TOUR"),
          ].length,
        },
      },
    });
  } catch (error) {
    console.error("Error searching rides:", error);
    res.status(500).json({
      error: "Failed to search rides",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
