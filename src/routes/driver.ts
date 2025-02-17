import type { Request, Response } from "express";
import express from "express";
import { PrismaClient } from "@prisma/client";
import multer from "multer";

import { verifyToken } from "../middlewares/auth";
import {
  getDriverRideHistory,
  getDriverCurrentRide,
} from "../controllers/driverController";
import { uploadImage } from "../config/cloudinary";

const router = express.Router();
const prisma = new PrismaClient();
import { io } from "../server";

const upload = multer();

// Get all drivers
router.get("/", verifyToken, async (req: Request, res: Response) => {
  try {
    const drivers = await prisma.user.findMany({
      where: {
        userType: "DRIVER",
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

    res.json(drivers);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch drivers" });
  }
});

// Get driver by ID
router.get("/:id", verifyToken, async (req: Request, res: Response) => {
  try {
    const driverId = req.params.id;
    const driver = await prisma.user.findUnique({
      where: { id: driverId },
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

    if (!driver || driver.userType !== "DRIVER") {
      return res.status(404).json({ error: "Driver not found" });
    }

    res.json(driver);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch driver" });
  }
});

// Update driver
router.put(
  "/:id",
  verifyToken,
  upload.single("selfie"),
  async (req: Request, res: Response) => {
    try {
      const driverId = req.params.id;
      const { name, email, state, city } = req.body;

      let selfieUrl;

      // Check if a new selfie file is uploaded
      if (req.file) {
        // Upload the new selfie to Cloudinary
        selfieUrl = await uploadImage(req.file.buffer);
      }

      const updatedDriver = await prisma.user.update({
        where: { id: driverId },
        data: {
          name,
          email,
          state,
          city,
          ...(selfieUrl && { selfieUrl }), // Only update selfieUrl if a new image was uploaded
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

      res.json(updatedDriver);
    } catch (error) {
      console.error("Error updating driver:", error);
      res.status(500).json({ error: "Failed to update driver" });
    }
  }
);

// Delete driver
router.delete("/:id", verifyToken, async (req: Request, res: Response) => {
  try {
    const driverId = req.params.id;

    // First delete related records
    await prisma.driverDetails.deleteMany({ where: { userId: driverId } });

    // Then delete the driver
    await prisma.user.delete({ where: { id: driverId } });

    res.json({ message: "Driver deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete driver" });
  }
});

// Update Driver Status and Location
router.post("/update-status", async (req, res) => {
  try {
    const { driverId, isOnline, locationLat, locationLng, socketId } = req.body;

    // Validate input
    if (!driverId) {
      return res.status(400).json({ error: "Driver ID is required" });
    }

    // Update driver status in database
    const updatedDriverStatus = await prisma.driverStatus.upsert({
      where: { driverId },
      update: {
        isOnline: isOnline ?? undefined,
        locationLat: locationLat ?? undefined,
        locationLng: locationLng ?? undefined,
        updatedAt: new Date(),
        lastLocationUpdate: new Date(),
        socketId: socketId ?? undefined,
      },
      create: {
        driverId,
        isOnline: isOnline ?? false,
        locationLat,
        locationLng,
        socketId: socketId ?? undefined,
        lastLocationUpdate: new Date(),
      },
    });

    // Emit socket event for real-time updates
    io.emit(`driver_status_${driverId}`, {
      driverId,
      isOnline: updatedDriverStatus.isOnline,
      locationLat: updatedDriverStatus.locationLat,
      locationLng: updatedDriverStatus.locationLng,
      socketId: updatedDriverStatus.socketId,
      updatedAt: updatedDriverStatus.updatedAt,
    });

    res.json(updatedDriverStatus);
  } catch (error) {
    console.error("Error updating driver status:", error);
    res.status(500).json({ error: "Failed to update driver status" });
  }
});

// Get Driver Current Status
router.get("/current-status/:driverId", async (req, res) => {
  try {
    const { driverId } = req.params;

    const driverStatus = await prisma.driverStatus.findUnique({
      where: { driverId },
      include: { driver: true },
    });

    if (!driverStatus) {
      return res.status(404).json({ error: "Driver status not found" });
    }

    res.json(driverStatus);
  } catch (error) {
    console.error("Error fetching driver status:", error);
    res.status(500).json({ error: "Failed to fetch driver status" });
  }
});

// Get driver's ride history
router.get("/:driverId/ride-history", getDriverRideHistory);

// Get driver's current ride
router.get("/:driverId/current-ride", getDriverCurrentRide);

// Get detailed driver information
router.get(
  "/:driverId/details",
  verifyToken,
  async (req: Request, res: Response) => {
    try {
      const { driverId } = req.params;

      const driverDetails = await prisma.user.findUnique({
        where: {
          id: driverId,
          userType: "DRIVER",
        },
        select: {
          id: true,
          name: true,
          phone: true,
          email: true,
          selfieUrl: true,
          state: true,
          city: true,
          createdAt: true,
          updatedAt: true,
          userType: true,

          driverDetails: {
            select: {
              vehicleNumber: true,
              vehicleName: true,
              vehicleCategory: true,
              dlNumber: true,
              carCategory: true,
              carFrontUrl: true,
              carBackUrl: true,
            },
          },
          ridesAsDriver: {
            select: {
              id: true,
              status: true,
              createdAt: true,
              rideType: true,
            },
          },
          longDistanceBookingsAsDriver: {
            select: {
              id: true,
              status: true,
              createdAt: true,
              serviceType: true,
            },
          },
        },
      });

      if (!driverDetails) {
        return res.status(404).json({ error: "Driver not found" });
      }

      // Calculate total and completed local rides
      const completedLocalRides = driverDetails.ridesAsDriver.filter(
        (ride) =>
          ride.status === "RIDE_ENDED" || ride.status === "PAYMENT_COMPLETED"
      ).length;

      // Calculate total and completed long distance rides
      const completedLongDistanceRides =
        driverDetails.longDistanceBookingsAsDriver.filter(
          (booking) => booking.status === "COMPLETED"
        ).length;

      const response = {
        ...driverDetails,
        totalTrips:
          driverDetails.ridesAsDriver.length +
          driverDetails.longDistanceBookingsAsDriver.length,
        completedTrips: completedLocalRides + completedLongDistanceRides,
        localTrips: {
          total: driverDetails.ridesAsDriver.length,
          completed: completedLocalRides,
        },
        longDistanceTrips: {
          total: driverDetails.longDistanceBookingsAsDriver.length,
          completed: completedLongDistanceRides,
        },
        // Remove detailed ride information from response
        ridesAsDriver: undefined,
        longDistanceBookingsAsDriver: undefined,
      };

      res.json(response);
    } catch (error) {
      console.error("Error fetching driver details:", error);
      res.status(500).json({ error: "Failed to fetch driver details" });
    }
  }
);

export { router as driverRouter };
