import { PrismaClient } from "@prisma/client";
import type { Request, Response } from "express";
import express from "express";
import multer from "multer";

import { uploadImage } from "../config/cloudinary";
import {
  getAllDriverInfo,
  getDriverApprovalStatus,
  getDriverCurrentRide,
  getDriverRideHistory,
  updateDriverProfile,
} from "../controllers/driverController";
import { verifyToken } from "../middlewares/auth";
import { io } from "../server";

const router = express.Router();
const prisma = new PrismaClient();

const upload = multer();

// Get all drivers
router.get(
  "/",
  verifyToken,
  async (req: Request, res: Response): Promise<void> => {
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
  }
);

// Get driver by ID
router.get(
  "/:id",
  verifyToken,
  async (req: Request, res: Response): Promise<void> => {
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
          driverDetails: {
            select: {
              hasCarrier: true,
              vehicleNumber: true,
              vehicleName: true,
              vehicleCategory: true,
            },
          },
        },
      });

      if (!driver || driver.userType !== "DRIVER") {
        res.status(404).json({ error: "Driver not found" });
        return;
      }

      res.json(driver);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch driver" });
    }
  }
);

// Update driver
router.put(
  "/:id",
  verifyToken,
  upload.single("selfie"),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const driverId = req.params.id;
      const { name, email, state, city, hasCarrier } = req.body;

      // Validate driver exists first
      const driverExists = await prisma.user.findUnique({
        where: {
          id: driverId,
          userType: "DRIVER",
        },
      });

      if (!driverExists) {
        res.status(404).json({ error: "Driver not found" });
        return;
      }

      let selfieUrl;

      // Check if a new selfie file is uploaded
      if (req.file) {
        // Upload the new selfie to Cloudinary
        selfieUrl = await uploadImage(req.file.buffer);
      }

      // Begin transaction to update both user and driver details
      const [updatedDriver, updatedDriverDetails] = await prisma.$transaction([
        prisma.user.update({
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
        }),

        // Update driver details if hasCarrier is provided
        hasCarrier !== undefined
          ? prisma.driverDetails.update({
              where: { userId: driverId },
              data: {
                hasCarrier: hasCarrier === "true" || hasCarrier === true,
              },
              select: {
                hasCarrier: true,
                vehicleCategory: true,
                vehicleName: true,
                vehicleNumber: true,
              },
            })
          : prisma.driverDetails.findUnique({
              where: { userId: driverId },
              select: {
                hasCarrier: true,
                vehicleCategory: true,
                vehicleName: true,
                vehicleNumber: true,
              },
            }),
      ]);

      res.json({
        ...updatedDriver,
        driverDetails: updatedDriverDetails,
      });
    } catch (error) {
      console.error("Error updating driver:", error);
      res.status(500).json({ error: "Failed to update driver" });
    }
  }
);

// Delete driver
router.delete(
  "/:id",
  verifyToken,
  async (req: Request, res: Response): Promise<void> => {
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
  }
);

// Update Driver Status and Location
router.post(
  "/update-status",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { driverId, isOnline, locationLat, locationLng, socketId } =
        req.body;

      // Validate input
      if (!driverId) {
        res.status(400).json({ error: "Driver ID is required" });
        return;
      }

      // Check if driver exists
      const driverExists = await prisma.user.findUnique({
        where: {
          id: driverId,
          userType: "DRIVER",
        },
      });

      if (!driverExists) {
        res.status(404).json({ error: "Driver not found" });
        return;
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
  }
);

// Get Driver Current Status
router.get(
  "/current-status/:driverId",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { driverId } = req.params;

      // Check if driver exists
      const driverExists = await prisma.user.findUnique({
        where: {
          id: driverId,
          userType: "DRIVER",
        },
      });

      if (!driverExists) {
        res.status(404).json({ error: "Driver not found" });
        return;
      }

      const driverStatus = await prisma.driverStatus.findUnique({
        where: { driverId },
        include: { driver: true },
      });

      if (!driverStatus) {
        res.status(404).json({ error: "Driver status not found" });
        return;
      }

      res.json(driverStatus);
    } catch (error) {
      console.error("Error fetching driver status:", error);
      res.status(500).json({ error: "Failed to fetch driver status" });
    }
  }
);

// Define route handler types
type RouteHandler = (req: Request, res: Response) => Promise<void>;

// Get driver's ride history
router.get("/:driverId/ride-history", getDriverRideHistory as RouteHandler);

// Get driver's current ride
router.get("/:driverId/current-ride", getDriverCurrentRide as RouteHandler);

// Get detailed driver information
router.get(
  "/:driverId/details",
  verifyToken,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { driverId } = req.params;

      // Check if driver exists
      const driverExists = await prisma.user.findUnique({
        where: {
          id: driverId,
          userType: "DRIVER",
        },
      });

      if (!driverExists) {
        res.status(404).json({ error: "Driver not found" });
        return;
      }

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
        res.status(404).json({ error: "Driver not found" });
        return;
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

// Get driver's full profile including all document URLs
router.get("/profile/all", verifyToken, getAllDriverInfo as RouteHandler);

// Update driver profile with all details and documents
router.put(
  "/profile/update",
  verifyToken,
  upload.fields([
    { name: "selfiePath", maxCount: 1 },
    { name: "dlPath", maxCount: 1 },
    { name: "permitImages", maxCount: 4 },
    { name: "carFront", maxCount: 1 },
    { name: "carBack", maxCount: 1 },
    { name: "rcDocument", maxCount: 1 },
    { name: "fitnessDocument", maxCount: 1 },
    { name: "pollutionDocument", maxCount: 1 },
    { name: "insuranceDocument", maxCount: 1 },
  ]),
  updateDriverProfile as RouteHandler
);

router.get(
  "/:driverId/approval-status",
  getDriverApprovalStatus as RouteHandler
);

export { router as driverRouter };
