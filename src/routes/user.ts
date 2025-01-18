import type { Request, Response } from "express";
import {
  LongDistanceBookingStatus,
  PrismaClient,
  RideStatus,
} from "@prisma/client";
import express from "express";

import { verifyToken } from "../middlewares/auth";

const router = express.Router();

const prisma = new PrismaClient();

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
router.put("/:id", verifyToken, async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const userId = req.user.userId;
    const { name, email, state, city } = req.body;

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        name,
        email,
        state,
        city,
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
    res.status(500).json({ error: "Failed to update user" });
  }
});

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

// Get all rides for a user (local and long distance rides)
router.get("/:id/rides", verifyToken, async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const userId = req.user.userId;

    // Get local rides with full details
    const localRides = await prisma.ride.findMany({
      where: { userId },
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
      where: { userId },
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

    res.json({
      localRides,
      longDistanceRides,
    });
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
