import {
  LongDistanceBookingStatus,
  LongDistanceServiceType,
  PrismaClient,
  RideStatus,
} from "@prisma/client";
import type { Request, RequestHandler, Response } from "express";
import express from "express";

import multer from "multer";
import { uploadImage } from "../config/cloudinary";
import { getUserOutstandingFee } from "../controllers/userController";
import { verifyToken } from "../middlewares/auth";

const router = express.Router();

const prisma = new PrismaClient();

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

//get  all user details

router.get("/", async (req: Request, res: Response) => {
  try {
    const users = await prisma.user.findMany({
      where: {
        userType: "USER",
      },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        selfieUrl: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    res.json(users);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

// Get user by ID
router.get("/:id", verifyToken, async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const userId = req.user.userId;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        selfieUrl: true,
        state: true,
        city: true,
        userType: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json(user);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch user" });
  }
});

// Update user
router.put(
  "/:id",
  verifyToken,
  upload.single("selfie"),
  async (req: Request, res: Response) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const userId = req.user.userId;
      const { name, email, state, city } = req.body;

      let selfieUrl = req.user.selfieUrl || "";

      // Check if a new selfie file is uploaded
      if (req.file) {
        // Upload the new selfie to Cloudinary
        selfieUrl = await uploadImage(req.file.buffer);
      }

      const updatedUser = await prisma.user.update({
        where: { id: userId },
        data: {
          name,
          email,
          state,
          city,
          selfieUrl, // Update the selfie URL if a new one is uploaded
        },
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          selfieUrl: true,
          state: true,
          city: true,
          userType: true,
          updatedAt: true,
        },
      });

      res.json(updatedUser);
    } catch (error) {
      console.error("Error updating user:", error);
      res.status(500).json({ error: "Failed to update user" });
    }
  }
);

// Delete user
router.delete("/:id", verifyToken, async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const userId = req.user.userId;

    // First delete related records
    await prisma.userDetails.deleteMany({ where: { userId: userId } });
    await prisma.driverDetails.deleteMany({ where: { userId: userId } });
    await prisma.vendorDetails.deleteMany({ where: { userId: userId } });

    // Then delete the user
    await prisma.user.delete({ where: { id: userId } });

    res.json({ message: "User deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete user" });
  }
});

// Get all rides for a user (all services)
router.get("/:id/rides", verifyToken, async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const userId = req.user.userId;

    // Get service filter from query params
    const serviceFilter = req.query.service as string | undefined;

    // Build filter conditions for local rides (city ride and car rental)
    const localRideFilter: any = { userId };

    // Build filter conditions for long distance rides
    const longDistanceFilter: any = { userId };
    if (
      serviceFilter === "OUTSTATION" ||
      serviceFilter === "HILL_STATION" ||
      serviceFilter === "CHARDHAM_YATRA" ||
      serviceFilter === "ALL_INDIA_TOUR"
    ) {
      longDistanceFilter.serviceType = serviceFilter as LongDistanceServiceType;
    }

    // Specific filters for car rental and city ride
    let carRentalFilter = {};
    let cityRideFilter = {};

    if (serviceFilter === "CAR_RENTAL") {
      carRentalFilter = { isCarRental: true };
      localRideFilter.isCarRental = true;
    } else if (serviceFilter === "CITY_RIDE") {
      cityRideFilter = { isCarRental: false, rideType: "LOCAL" };
      localRideFilter.isCarRental = false;
      localRideFilter.rideType = "LOCAL";
    }

    // Get local rides with full details
    const localRides = await prisma.ride.findMany({
      where: localRideFilter,
      include: {
        driver: {
          select: {
            id: true,
            name: true,
            phone: true,
            email: true,
            driverDetails: {
              select: {
                vehicleName: true,
                vehicleNumber: true,
                vehicleCategory: true,
              },
            },
            driverStatus: {
              select: {
                isOnline: true,
                locationLat: true,
                locationLng: true,
              },
            },
          },
        },
        transactions: {
          select: {
            id: true,
            amount: true,
            status: true,
            type: true,
            razorpayOrderId: true,
            razorpayPaymentId: true,
            createdAt: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    // Get long distance rides with full details
    const longDistanceRides = await prisma.longDistanceBooking.findMany({
      where: longDistanceFilter,
      include: {
        driver: {
          select: {
            id: true,
            name: true,
            phone: true,
            email: true,
            driverDetails: {
              select: {
                vehicleName: true,
                vehicleNumber: true,
                vehicleCategory: true,
              },
            },
            driverStatus: {
              select: {
                isOnline: true,
                locationLat: true,
                locationLng: true,
              },
            },
          },
        },
        transactions: {
          select: {
            id: true,
            amount: true,
            status: true,
            type: true,
            razorpayOrderId: true,
            razorpayPaymentId: true,
            createdAt: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    // Transform and categorize rides
    const cityRides = localRides
      .filter((ride) => !ride.isCarRental && ride.rideType === "LOCAL")
      .map((ride) => ({
        ...ride,
        serviceCategory: "LOCAL",
        serviceType: "CITY_RIDE",
      }));

    const carRentalRides = localRides
      .filter((ride) => ride.isCarRental)
      .map((ride) => ({
        ...ride,
        serviceCategory: "LOCAL",
        serviceType: "CAR_RENTAL",
        rentalDetails: {
          packageHours: ride.rentalPackageHours,
          packageKms: ride.rentalPackageKms,
          basePrice: ride.rentalBasePrice,
          actualKmsTravelled: ride.actualKmsTravelled,
          actualMinutes: ride.actualMinutes,
          extraKmCharges: ride.extraKmCharges,
          extraMinuteCharges: ride.extraMinuteCharges,
        },
      }));

    const outstationRides = longDistanceRides
      .filter((ride) => ride.serviceType === "OUTSTATION")
      .map((ride) => ({
        ...ride,
        serviceCategory: "LONG_DISTANCE",
        serviceType: "OUTSTATION",
        tripDetails: {
          startDate: ride.startDate,
          endDate: ride.endDate,
          totalDays: ride.totalDays,
          tripType: ride.tripType,
          advanceAmount: ride.advanceAmount,
          remainingAmount: ride.remainingAmount,
        },
      }));

    const hillStationRides = longDistanceRides
      .filter((ride) => ride.serviceType === "HILL_STATION")
      .map((ride) => ({
        ...ride,
        serviceCategory: "LONG_DISTANCE",
        serviceType: "HILL_STATION",
        tripDetails: {
          startDate: ride.startDate,
          endDate: ride.endDate,
          totalDays: ride.totalDays,
          tripType: ride.tripType,
          advanceAmount: ride.advanceAmount,
          remainingAmount: ride.remainingAmount,
        },
      }));

    const chardhamRides = longDistanceRides
      .filter((ride) => ride.serviceType === "CHARDHAM_YATRA")
      .map((ride) => ({
        ...ride,
        serviceCategory: "LONG_DISTANCE",
        serviceType: "CHARDHAM_YATRA",
        tripDetails: {
          startDate: ride.startDate,
          endDate: ride.endDate,
          totalDays: ride.totalDays,
          tripType: ride.tripType,
          advanceAmount: ride.advanceAmount,
          remainingAmount: ride.remainingAmount,
        },
      }));

    const allIndiaRides = longDistanceRides
      .filter((ride) => ride.serviceType === "ALL_INDIA_TOUR")
      .map((ride) => ({
        ...ride,
        serviceCategory: "LONG_DISTANCE",
        serviceType: "ALL_INDIA_TOUR",
        tripDetails: {
          startDate: ride.startDate,
          endDate: ride.endDate,
          totalDays: ride.totalDays,
          tripType: ride.tripType,
          advanceAmount: ride.advanceAmount,
          remainingAmount: ride.remainingAmount,
        },
      }));

    // Combine all rides
    const allRides = {
      cityRides,
      carRentalRides,
      outstationRides,
      hillStationRides,
      chardhamRides,
      allIndiaRides,
    };

    // Return filtered results based on service type
    if (serviceFilter === "CITY_RIDE") {
      return res.json({ rides: cityRides });
    } else if (serviceFilter === "CAR_RENTAL") {
      return res.json({ rides: carRentalRides });
    } else if (serviceFilter === "OUTSTATION") {
      return res.json({ rides: outstationRides });
    } else if (serviceFilter === "HILL_STATION") {
      return res.json({ rides: hillStationRides });
    } else if (serviceFilter === "CHARDHAM_YATRA") {
      return res.json({ rides: chardhamRides });
    } else if (serviceFilter === "ALL_INDIA_TOUR") {
      return res.json({ rides: allIndiaRides });
    } else if (serviceFilter === "LONG_DISTANCE") {
      // Return all long distance rides combined
      return res.json({
        rides: [
          ...outstationRides,
          ...hillStationRides,
          ...chardhamRides,
          ...allIndiaRides,
        ],
      });
    } else if (serviceFilter === "LOCAL") {
      // Return all local rides combined
      return res.json({
        rides: [...cityRides, ...carRentalRides],
      });
    }

    // Return all rides if no specific filter is applied
    res.json(allRides);
  } catch (error) {
    console.error("Error fetching rides:", error);
    res.status(500).json({ error: "Failed to fetch rides" });
  }
});

// Get vendor profile
router.get(
  "/vendor/profile",
  verifyToken,
  async (req: Request, res: Response) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const userId = req.user.userId;

      const vendor = await prisma.user.findUnique({
        where: {
          id: userId,
          userType: "VENDOR",
        },
        include: {
          vendorDetails: true,
          vendorBookings: {
            orderBy: { createdAt: "desc" },
            take: 10, // Optional: limit recent bookings
          },
        },
      });

      if (!vendor) {
        return res.status(404).json({ error: "Vendor not found" });
      }

      res.json(vendor);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch vendor profile" });
    }
  }
);

// Update vendor profile
router.put(
  "/vendor/profile",
  verifyToken,
  async (req: Request, res: Response) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const userId = req.user.userId;

      const {
        name,
        email,
        state,
        city,
        vendorDetails: {
          businessName,
          address,
          experience,
          gstNumber,
          aadharNumber,
          panNumber,
        },
      } = req.body;

      const updatedVendor = await prisma.user.update({
        where: {
          id: userId,
          userType: "VENDOR",
        },
        data: {
          name,
          email,
          state,
          city,
          vendorDetails: {
            upsert: {
              create: {
                businessName,
                address,
                experience,
                gstNumber,
                aadharNumber,
                panNumber,
              },
              update: {
                businessName,
                address,
                experience,
                gstNumber,
                aadharNumber,
                panNumber,
              },
            },
          },
        },
        include: {
          vendorDetails: true,
        },
      });

      res.json(updatedVendor);
    } catch (error) {
      console.error("Error updating vendor:", error);
      res.status(500).json({ error: "Failed to update vendor profile" });
    }
  }
);

// Get recent rides for a user
router.get(
  "/:id/recent-rides",
  verifyToken,
  async (req: Request, res: Response) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const userId = req.user.userId;

      // Get recent local rides
      const recentLocalRides = await prisma.ride.findMany({
        where: {
          userId,
          OR: [
            { status: RideStatus.PAYMENT_COMPLETED },
            { status: RideStatus.RIDE_ENDED },
          ],
        },
        include: {
          driver: {
            select: {
              id: true,
              name: true,
              phone: true,
              driverDetails: {
                select: {
                  vehicleName: true,
                  vehicleNumber: true,
                },
              },
            },
          },
          transactions: {
            select: {
              amount: true,
              status: true,
            },
          },
        },
        orderBy: {
          createdAt: "desc",
        },
        take: 10, // Limit to last 10 rides
      });

      // Get recent long distance rides
      const recentLongDistanceRides = await prisma.longDistanceBooking.findMany(
        {
          where: {
            userId,
            OR: [{ status: LongDistanceBookingStatus.COMPLETED }],
          },
          include: {
            driver: {
              select: {
                id: true,
                name: true,
                phone: true,
                driverDetails: {
                  select: {
                    vehicleName: true,
                    vehicleNumber: true,
                  },
                },
              },
            },
            transactions: {
              select: {
                amount: true,
                status: true,
              },
            },
          },
          orderBy: {
            createdAt: "desc",
          },
          take: 10,
        }
      );

      // Combine and sort rides by date
      const allRecentRides = [...recentLocalRides, ...recentLongDistanceRides]
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, 10); // Get most recent 10 rides overall

      res.json(allRecentRides);
    } catch (error) {
      console.error("Error fetching recent rides:", error);
      res.status(500).json({ error: "Failed to fetch recent rides" });
    }
  }
);

// Get the outstanding cancellation fee for the logged-in user
router.get(
  "/me/outstanding-fee",
  verifyToken,
  getUserOutstandingFee as unknown as RequestHandler
);

// Complete account deletion route (protected version)
router.delete(
  "/account/delete",
  verifyToken,
  async (req: Request, res: Response) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const userId = req.user.userId;

      // Start a transaction to ensure all related data is deleted or none at all
      await prisma.$transaction(async (tx) => {
        // 1. First get all rides where user is driver or user
        const userRides = await tx.ride.findMany({
          where: {
            OR: [{ userId: userId }, { driverId: userId }],
          },
          select: { id: true },
        });

        const rideIds = userRides.map((ride) => ride.id);

        // 2. Delete chat messages for these rides first
        if (rideIds.length > 0) {
          await tx.chatMessage.deleteMany({
            where: {
              rideId: { in: rideIds },
            },
          });
        }

        // 3. Delete chat messages sent by user (that might not be related to rides)
        await tx.chatMessage.deleteMany({
          where: { senderId: userId },
        });

        // 4. Delete transactions
        await tx.transaction.deleteMany({
          where: {
            OR: [{ senderId: userId }, { receiverId: userId }],
          },
        });

        // 5. Delete long distance transactions
        await tx.longDistanceTransaction.deleteMany({
          where: {
            OR: [{ senderId: userId }, { receiverId: userId }],
          },
        });

        // 6. Delete vendor booking transactions
        await tx.vendorBookingTransaction.deleteMany({
          where: {
            OR: [{ senderId: userId }, { receiverId: userId }],
          },
        });

        // 7. Delete ride location logs for rides
        if (rideIds.length > 0) {
          await tx.rideLocationLog.deleteMany({
            where: {
              rideId: { in: rideIds },
            },
          });
        }

        // 8. Now delete rides as driver
        await tx.ride.deleteMany({
          where: { driverId: userId },
        });

        // 9. Delete rides as user
        await tx.ride.deleteMany({
          where: { userId: userId },
        });

        // 10. Delete long distance bookings as driver
        await tx.longDistanceBooking.deleteMany({
          where: { driverId: userId },
        });

        // 11. Delete long distance bookings as user
        await tx.longDistanceBooking.deleteMany({
          where: { userId: userId },
        });

        // 12. Delete vendor bookings as driver
        await tx.vendorBooking.deleteMany({
          where: { driverId: userId },
        });

        // 13. Delete vendor bookings as vendor
        await tx.vendorBooking.deleteMany({
          where: { vendorId: userId },
        });

        // 14. Delete driver status
        await tx.driverStatus.deleteMany({
          where: { driverId: userId },
        });

        // 15. Delete wallet
        await tx.wallet.deleteMany({
          where: { userId: userId },
        });

        // 16. Delete user details
        await tx.userDetails.deleteMany({
          where: { userId: userId },
        });

        // 17. Delete driver details
        await tx.driverDetails.deleteMany({
          where: { userId: userId },
        });

        // 18. Delete vendor details
        await tx.vendorDetails.deleteMany({
          where: { userId: userId },
        });

        // 19. Finally, delete the user
        await tx.user.delete({
          where: { id: userId },
        });
      });

      res.status(200).json({
        message: "Account and all associated data deleted successfully",
      });
    } catch (error) {
      console.error("Error deleting account:", error);
      res.status(500).json({ error: "Failed to delete account" });
    }
  }
);

// Public account deletion route for testing (PlayStore review)
router.delete("/public/delete/:userId", async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({ error: "User ID is required" });
    }

    // Check if user exists
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Start a transaction to ensure all related data is deleted or none at all
    await prisma.$transaction(async (tx) => {
      // 1. First get all rides where user is driver or user
      const userRides = await tx.ride.findMany({
        where: {
          OR: [{ userId: userId }, { driverId: userId }],
        },
        select: { id: true },
      });

      const rideIds = userRides.map((ride) => ride.id);

      // 2. Delete chat messages for these rides first
      if (rideIds.length > 0) {
        await tx.chatMessage.deleteMany({
          where: {
            rideId: { in: rideIds },
          },
        });
      }

      // 3. Delete chat messages sent by user (that might not be related to rides)
      await tx.chatMessage.deleteMany({
        where: { senderId: userId },
      });

      // 4. Delete transactions
      await tx.transaction.deleteMany({
        where: {
          OR: [{ senderId: userId }, { receiverId: userId }],
        },
      });

      // 5. Delete long distance transactions
      await tx.longDistanceTransaction.deleteMany({
        where: {
          OR: [{ senderId: userId }, { receiverId: userId }],
        },
      });

      // 6. Delete vendor booking transactions
      await tx.vendorBookingTransaction.deleteMany({
        where: {
          OR: [{ senderId: userId }, { receiverId: userId }],
        },
      });

      // 7. Delete ride location logs for rides
      if (rideIds.length > 0) {
        await tx.rideLocationLog.deleteMany({
          where: {
            rideId: { in: rideIds },
          },
        });
      }

      // 8. Now delete rides as driver
      await tx.ride.deleteMany({
        where: { driverId: userId },
      });

      // 9. Delete rides as user
      await tx.ride.deleteMany({
        where: { userId: userId },
      });

      // 10. Delete long distance bookings as driver
      await tx.longDistanceBooking.deleteMany({
        where: { driverId: userId },
      });

      // 11. Delete long distance bookings as user
      await tx.longDistanceBooking.deleteMany({
        where: { userId: userId },
      });

      // 12. Delete vendor bookings as driver
      await tx.vendorBooking.deleteMany({
        where: { driverId: userId },
      });

      // 13. Delete vendor bookings as vendor
      await tx.vendorBooking.deleteMany({
        where: { vendorId: userId },
      });

      // 14. Delete driver status
      await tx.driverStatus.deleteMany({
        where: { driverId: userId },
      });

      // 15. Delete wallet
      await tx.wallet.deleteMany({
        where: { userId: userId },
      });

      // 16. Delete user details
      await tx.userDetails.deleteMany({
        where: { userId: userId },
      });

      // 17. Delete driver details
      await tx.driverDetails.deleteMany({
        where: { userId: userId },
      });

      // 18. Delete vendor details
      await tx.vendorDetails.deleteMany({
        where: { userId: userId },
      });

      // 19. Finally, delete the user
      await tx.user.delete({
        where: { id: userId },
      });
    });

    res.status(200).json({
      message: "Account and all associated data deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting account:", error);
    res.status(500).json({ error: "Failed to delete account" });
  }
});

export { router as userRouter };
