import type { Request, Response } from "express";
import express from "express";
import { PrismaClient } from "@prisma/client";

import { verifyToken } from "../middlewares/auth";

const router = express.Router();
const prisma = new PrismaClient();
import { io } from "../server";

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
router.put("/:id", verifyToken, async (req: Request, res: Response) => {
  try {
    const driverId = req.params.id;
    const { name, email, state, city } = req.body;

    const updatedDriver = await prisma.user.update({
      where: { id: driverId },
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

    res.json(updatedDriver);
  } catch (error) {
    res.status(500).json({ error: "Failed to update driver" });
  }
});

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
    const { driverId, isOnline, locationLat, locationLng } = req.body;

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
      },
      create: {
        driverId,
        isOnline: isOnline ?? false,
        locationLat,
        locationLng,
      },
    });

    // Emit socket event for real-time updates
    io.emit(`driver_status_${driverId}`, {
      driverId,
      isOnline: updatedDriverStatus.isOnline,
      locationLat: updatedDriverStatus.locationLat,
      locationLng: updatedDriverStatus.locationLng,
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

export { router as driverRouter };
