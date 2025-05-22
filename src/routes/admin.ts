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
import { verifyAdmin } from "../middlewares/auth";

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

export { router as adminRouter };
