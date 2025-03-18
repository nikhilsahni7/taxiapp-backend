import type { Request, Response } from "express";
import {
  LongDistanceBookingStatus,
  LongDistanceServiceType,
  PrismaClient,
  RideStatus,
  RideType,
} from "@prisma/client";
import express from "express";

import { verifyToken } from "../middlewares/auth";
import multer from "multer";
import { uploadImage } from "../config/cloudinary";

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
    const rideType = req.query.rideType as RideType | undefined;

    // Build filter conditions for local rides
    const localRideFilter: any = { userId };
    if (rideType) {
      localRideFilter.rideType = rideType;
    }

    // Build filter conditions for long distance rides
    const longDistanceFilter: any = { userId };
    if (
      serviceFilter &&
      Object.values(LongDistanceServiceType).includes(
        serviceFilter as LongDistanceServiceType
      )
    ) {
      longDistanceFilter.serviceType = serviceFilter;
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

    // Transform rides to include service type information
    const formattedLocalRides = localRides.map((ride) => ({
      ...ride,
      serviceCategory: "LOCAL",
      serviceType: ride.rideType,
      isCarRental: ride.isCarRental,
      rentalDetails: ride.isCarRental
        ? {
            packageHours: ride.rentalPackageHours,
            packageKms: ride.rentalPackageKms,
            basePrice: ride.rentalBasePrice,
            actualKmsTravelled: ride.actualKmsTravelled,
            actualMinutes: ride.actualMinutes,
            extraKmCharges: ride.extraKmCharges,
            extraMinuteCharges: ride.extraMinuteCharges,
          }
        : null,
      outstationDetails:
        ride.rideType === "OUTSTATION"
          ? {
              tripType: ride.outstationType,
            }
          : null,
    }));

    const formattedLongDistanceRides = longDistanceRides.map((ride) => ({
      ...ride,
      serviceCategory: "LONG_DISTANCE",
      serviceType: ride.serviceType,
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
      localRides: formattedLocalRides,
      longDistanceRides: formattedLongDistanceRides,
    };

    // If a specific service filter is applied, return only that service
    if (serviceFilter === "LOCAL" || rideType) {
      return res.json({ rides: formattedLocalRides });
    } else if (
      serviceFilter === "LONG_DISTANCE" ||
      [
        "OUTSTATION",
        "HILL_STATION",
        "CHARDHAM_YATRA",
        "ALL_INDIA_TOUR",
      ].includes(serviceFilter || "")
    ) {
      return res.json({ rides: formattedLongDistanceRides });
    }

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

// Add this to your existing user router

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

export { router as userRouter };
