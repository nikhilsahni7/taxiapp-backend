import type { Request, Response } from "express";
import express from "express";
import {
  adjustWalletBalance,
  getActiveLocalRidesStatus,
  getActiveLongDistanceRidesStatus,
  getActiveVendorRidesStatus,
  getAllDriversForApproval,
  getAllRidesData,
  getAllUsers,
  getAllWalletsSummary,
  getDetailedStats,
  getDriverForApproval,
  getPendingWithdrawals,
  getUserTransactions,
  handleWithdrawal,
  searchRidesAcrossServices,
  updateDriverApproval,
} from "../controllers/adminController";
import { prisma } from "../lib/prisma";
import { verifyAdmin } from "../middlewares/auth";
import { AutoCancellationService } from "../services/autoCancellationService";

// Helper type to ensure controllers return Promise<void>
type AsyncController = (req: Request, res: Response) => Promise<void>;

const router = express.Router();

// Comprehensive data endpoints
router.get("/rides/all", verifyAdmin, getAllRidesData as AsyncController);
router.get("/stats", verifyAdmin, getDetailedStats as AsyncController);

// New route for searching rides across services
router.get(
  "/rides/search",
  verifyAdmin,
  searchRidesAcrossServices as AsyncController
);

// Withdrawal management
router.get(
  "/withdrawals",
  verifyAdmin,
  getPendingWithdrawals as AsyncController
);
router.post(
  "/withdrawals/:transactionId",
  verifyAdmin,
  handleWithdrawal as AsyncController
);

// Active rides status
router.get(
  "/rides/active/local",
  verifyAdmin,
  getActiveLocalRidesStatus as AsyncController
);
router.get(
  "/rides/active/long-distance",
  verifyAdmin,
  getActiveLongDistanceRidesStatus as AsyncController
);
router.get(
  "/rides/active/vendor",
  verifyAdmin,
  getActiveVendorRidesStatus as AsyncController
);

//wallet routes
router.get(
  "/transactions/:userId",
  verifyAdmin,
  getUserTransactions as AsyncController
);
router.post(
  "/wallet/:userId/adjust",
  verifyAdmin,
  adjustWalletBalance as AsyncController
);
router.get(
  "/wallets/summary",
  verifyAdmin,
  getAllWalletsSummary as AsyncController
);

// Add new route for getting all users
router.get("/users", verifyAdmin, getAllUsers as AsyncController);

// Driver approval routes
router.get(
  "/drivers/approval",
  verifyAdmin,
  getAllDriversForApproval as AsyncController
);
router.get(
  "/drivers/approval/:driverId",
  verifyAdmin,
  getDriverForApproval as AsyncController
);
router.post(
  "/drivers/approval/:driverId",
  verifyAdmin,
  updateDriverApproval as AsyncController
);

// Add this endpoint before the trigger endpoint
router.get("/auto-cancellation-status", async (req: Request, res: Response) => {
  try {
    // Get current IST time
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(now.getTime() + istOffset);

    // Count pending long distance bookings
    const pendingLongDistanceBookings = await prisma.longDistanceBooking.count({
      where: {
        status: {
          in: ["PENDING", "ADVANCE_PAID"],
        },
      },
    });

    // Count pending vendor bookings
    const pendingVendorBookings = await prisma.vendorBooking.count({
      where: {
        status: "PENDING",
      },
    });

    // Count auto-cancelled long distance bookings (in the last 24 hours)
    const yesterday = new Date(istNow.getTime() - 24 * 60 * 60 * 1000);
    const autoCancelledLongDistanceBookings =
      await prisma.longDistanceBooking.count({
        where: {
          cancelledBy: "SYSTEM",
          cancelledAt: {
            gte: yesterday,
          },
        },
      });

    // Count auto-cancelled vendor bookings (in the last 24 hours)
    const autoCancelledVendorBookings = await prisma.vendorBooking.count({
      where: {
        cancelledBy: "SYSTEM",
        cancelledAt: {
          gte: yesterday,
        },
      },
    });

    res.json({
      success: true,
      status: "Auto-cancellation service is active",
      currentISTTime: istNow.toISOString(),
      stats: {
        longDistanceBookings: {
          pending: pendingLongDistanceBookings,
          autoCancelledLast24h: autoCancelledLongDistanceBookings,
        },
        vendorBookings: {
          pending: pendingVendorBookings,
          autoCancelledLast24h: autoCancelledVendorBookings,
        },
        total: {
          pending: pendingLongDistanceBookings + pendingVendorBookings,
          autoCancelledLast24h:
            autoCancelledLongDistanceBookings + autoCancelledVendorBookings,
        },
      },
      cronSchedule: "Every minute (* * * * *)",
      timezone: "Asia/Kolkata",
    });
  } catch (error) {
    console.error("[Admin] Error getting auto-cancellation status:", error);
    res.status(500).json({
      success: false,
      message: "Failed to get auto-cancellation status",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// Add this endpoint near the end of the file, before export
router.post(
  "/trigger-auto-cancellation",
  async (req: Request, res: Response) => {
    try {
      console.log("[Admin] Manual trigger for auto-cancellation initiated");
      await AutoCancellationService.checkAndCancelOverdueBookings();
      res.json({
        success: true,
        message: "Auto-cancellation check completed successfully",
      });
    } catch (error) {
      console.error(
        "[Admin] Error in manual auto-cancellation trigger:",
        error
      );
      res.status(500).json({
        success: false,
        message: "Failed to execute auto-cancellation check",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);

export { router as adminRouter };
