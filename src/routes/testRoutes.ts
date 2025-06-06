import { PrismaClient } from "@prisma/client";
import { Router } from "express";
import { verifyToken } from "../middlewares/auth";
import {
  sendTaxiSureBookingNotification,
  sendTaxiSureRegularNotification,
  validateFcmToken,
} from "../utils/sendFcmNotification";

const router = Router();
const prisma = new PrismaClient();

// Test FCM notification endpoint
router.post("/test-fcm", verifyToken, async (req, res) => {
  try {
    const { fcmToken, type = "regular" } = req.body;

    if (!fcmToken) {
      return res.status(400).json({ error: "FCM token is required" });
    }

    console.log(`🧪 Testing FCM notification...`);
    console.log(`📱 Token: ${fcmToken.substring(0, 20)}...`);
    console.log(`🔍 Token valid: ${validateFcmToken(fcmToken)}`);

    if (type === "booking") {
      await sendTaxiSureBookingNotification(fcmToken, {
        bookingId: "TEST_BOOKING_123",
        amount: "₹500",
        pickupLocation: "Test Pickup Location",
        dropLocation: "Test Drop Location",
        distance: "5km",
        duration: "2hrs",
        rideType: "SUV",
      });
    } else {
      await sendTaxiSureRegularNotification(
        fcmToken,
        "Test Notification 🧪",
        "This is a test notification from your backend",
        "general",
        { testData: "backend-test" }
      );
    }

    res.json({
      success: true,
      message: `${type} notification sent successfully`,
      tokenValid: validateFcmToken(fcmToken),
    });
  } catch (error) {
    console.error("Test FCM error:", error);
    res.status(500).json({
      error: "Failed to send test notification",
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

// Check user's FCM token
router.get("/check-fcm-token", verifyToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: { fcmToken: true, name: true, phone: true },
    });

    res.json({
      user: {
        name: user?.name,
        phone: user?.phone,
        hasFcmToken: !!user?.fcmToken,
        fcmTokenLength: user?.fcmToken?.length || 0,
        fcmTokenPreview: user?.fcmToken?.substring(0, 20) + "...",
        isValidToken: user?.fcmToken ? validateFcmToken(user.fcmToken) : false,
      },
    });
  } catch (error) {
    console.error("Check FCM token error:", error);
    res.status(500).json({ error: "Failed to check FCM token" });
  }
});

// Check available drivers in area
router.post("/check-drivers", verifyToken, async (req, res) => {
  try {
    const { lat, lng, radius = 5 } = req.body;

    if (!lat || !lng) {
      return res
        .status(400)
        .json({ error: "Latitude and longitude are required" });
    }

    // Check total drivers in database
    const totalDrivers = await prisma.user.count({
      where: { userType: "DRIVER" },
    });

    // Check online drivers
    const onlineDrivers = await prisma.driverStatus.count({
      where: { isOnline: true },
    });

    // Check drivers with FCM tokens
    const driversWithFcm = await prisma.user.count({
      where: {
        userType: "DRIVER",
        fcmToken: { not: null },
      },
    });

    res.json({
      stats: {
        totalDrivers,
        onlineDrivers,
        driversWithFcm,
        searchLocation: { lat, lng, radius },
      },
      message: "Driver availability check completed",
    });
  } catch (error) {
    console.error("Check drivers error:", error);
    res.status(500).json({ error: "Failed to check drivers" });
  }
});

export default router;
